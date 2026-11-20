// Only externally mapped bank accounts with an active inbound connector can collect.
export const transferRoutesSql=`SELECT b.ledger_account_id,r.account_number AS account,r.bank_bic AS bic,
  r.country_code,r.connector_code AS profile,p.protocol,b.currency_code AS fiat,h.full_name AS beneficiary
 FROM avis_core_v2.abiq_bank_routes r JOIN avis_core_v2.abiq_routing_bridge b USING(bridge_id)
 JOIN avis_core_v2.holder_identities h ON h.record_user_id=b.user_id AND h.account_role='INSTITUTION'
 JOIN avis_core_v2.bank_connector_profiles p ON p.profile_id=r.connector_code
 JOIN avis_core_v2.platform_connectors c ON c.connector_code=p.profile_id AND c.is_enabled
 JOIN avis_core_v2.external_cash_accounts a ON a.cash_account_id=p.cash_account_id AND a.is_active AND a.currency_code=b.currency_code
 WHERE b.status='ACTIVE' AND r.account_type='IBAN' AND r.bank_bic IS NOT NULL`;
export const transferMethod=protocol=>protocol==='IP_TO_IP'?'INTERBANK':'WIRE';
export function transferReference(orderId){return orderId.replaceAll('-','').toUpperCase();}
export async function matchTransfer(db,order){
 // The connector has already authenticated the incoming message. The bank must also
 // have posted its exact fiat credit to this order's proceeds account.
 const ref=transferReference(order.order_id),route=order.terms.bankRoute;
 const candidates=(await db.query(`SELECT t.settlement_journal_id,t.raw_iso_payload
  FROM avis_core_v2.interbank_ip_transfers t
  JOIN avis_core_v2.ledger_entries e ON e.journal_id=t.settlement_journal_id AND e.account_id=t.source_account_id AND e.direction='CREDIT' AND e.amount=t.amount
  JOIN avis_core_v2.ledger_journals j ON j.journal_id=e.journal_id AND j.event_type='BANK_INCOMING_ALLOCATED'
  WHERE t.direction='INBOUND' AND t.iso_status='ACCC' AND t.profile_id=$1 AND t.source_account_id=$2 AND t.currency_code=$3 AND t.amount=$4
  AND j.created_at>=$5 AND position($6 in t.raw_iso_payload->>'xml')>0
  AND NOT EXISTS(SELECT 1 FROM avis_core_v2.crypto_basket_orders used WHERE used.funding_journal=t.settlement_journal_id)
  AND NOT EXISTS(SELECT 1 FROM avis_core_v2.ledger_journals rev WHERE rev.reverses_journal_id=j.journal_id)
  ORDER BY j.created_at LIMIT 4`,[route.profile,order.terms.proceeds,order.fiat,order.terms.total,order.created_at,ref])).rows;
 if(!candidates.length)return null;
 const {readIso20022}=await import('./iso20022.mjs');
 for(const candidate of candidates){const msg=await readIso20022(candidate.raw_iso_payload.xml);
  if(msg.reference===ref||msg.endToEndId===ref)return candidate.settlement_journal_id;}
 return null;
}
