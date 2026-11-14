import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export async function migrate(db) {
 await db.query('BEGIN');
 try {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('avis_core_v2:migration',0))");
  await db.query(`DO $$ BEGIN IF to_regclass('avis_core_v2.schema_migrations') IS NULL AND EXISTS
   (SELECT 1 FROM information_schema.tables WHERE table_schema='avis_core_v2') THEN
   RAISE EXCEPTION 'UNMANAGED_CORE_SCHEMA'; END IF; END $$`);
  await db.query('CREATE SCHEMA IF NOT EXISTS avis_core_v2');
  await db.query('CREATE TABLE IF NOT EXISTS avis_core_v2.schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>/^\d{3}_[a-z_]+\.sql$/.test(n)).sort()) {
   const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
   const checksum=createHash('sha256').update(sql).digest('hex');
   const existing=(await db.query('SELECT checksum FROM avis_core_v2.schema_migrations WHERE version=$1',[name])).rows[0];
   if(existing&&existing.checksum!==checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH: '+name);
   if(!existing) { if(db.exec) await db.exec(sql); else await db.query(sql);
    await db.query('INSERT INTO avis_core_v2.schema_migrations(version,checksum) VALUES($1,$2)',[name,checksum]); }
  }
  await db.query('COMMIT');
 } catch(e) {await db.query('ROLLBACK');throw e;}
}
