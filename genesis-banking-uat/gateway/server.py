"""Isolated ISO 20022 structure sandbox: no accounts, funds movement or storage."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import xml.etree.ElementTree as ET

ALLOWED = {"FIToFICstmrCdtTrf", "FICdtTrf", "BkToCstmrStmt", "BkToCstmrDbtCdtNtfctn", "CstmrCdtTrfInitn"}
MAX_SIZE = 512 * 1024

class Handler(BaseHTTPRequestHandler):
    def response(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == '/healthz':
            self.response(200, {'status':'ok','mode':'sandbox-only','financialPosting':False,'externalConnectivity':False})
        else:
            self.response(404, {'error':'not-found'})

    def do_POST(self):
        if self.path != '/validate':
            return self.response(404, {'error':'not-found'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self.response(400, {'error':'invalid-length'})
        if size <= 0 or size > MAX_SIZE:
            return self.response(413, {'error':'payload-limit'})
        data = self.rfile.read(size)
        # No DTD/entity expansion or external entities, independent of the parser behavior.
        if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
            return self.response(400, {'error':'DTD-and-entities-not-allowed'})
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            return self.response(400, {'error':'invalid-xml'})
        if root.tag.split('}')[-1] != 'Document':
            return self.response(422, {'error':'expected-iso20022-document'})
        if len(root) != 1 or root[0].tag.split('}')[-1] not in ALLOWED:
            return self.response(422, {'error':'message-family-not-supported'})
        name = root[0].tag.split('}')[-1]
        return self.response(200, {'acceptedForSandboxSyntaxCheck':True, 'messageFamily':name, 'schemaValidated':False,'posted':False, 'settled':False, 'transmitted':False})

    def log_message(self, *_):
        pass  # avoid logging sensitive payloads

if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8090), Handler).serve_forever()
