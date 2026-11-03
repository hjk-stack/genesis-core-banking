'use strict';

// AVISPay can be configured as its own acquirer and may separately use external
// payment services. This routing policy does not constitute scheme enablement,
// authorization, clearing or settlement.
const ROUTES=Object.freeze({
 AVISPAY_DIRECT:Object.freeze({kind:'own_acquirer',description:'AVISPay own acquiring BIN and MIT'}),
 STRIPE:Object.freeze({kind:'external_processor',description:'Stripe acquiring/payment services'}),
 BUCKZY:Object.freeze({kind:'external_processor',description:'Buckzy payment and collection services'})
});
const BIN=/^[0-9]{6,11}$/;
const REF=/^[A-Za-z0-9][A-Za-z0-9_:-]{1,63}$/;
function configureAcquiring({ownAcquirer,externalRoutes=[]}={}){
 if(!ownAcquirer||typeof ownAcquirer!=='object')throw Error('OWN_ACQUIRER_CONFIG_REQUIRED');
 const {bin,mit,processorId}=ownAcquirer;
 // Preserve the owner's term MIT; its issuing-body meaning needs confirmation
 // against scheme/processor registration before translating it to another field.
 if(typeof bin!=='string'||!BIN.test(bin))throw Error('INVALID_ACQUIRING_BIN');
 if(typeof mit!=='string'||!REF.test(mit))throw Error('INVALID_ACQUIRING_MIT');
 if(typeof processorId!=='string'||!REF.test(processorId))throw Error('INVALID_PROCESSOR_ID');
 if(!Array.isArray(externalRoutes))throw Error('INVALID_EXTERNAL_ROUTES');
 const routes=new Map([['AVISPAY_DIRECT',{id:'AVISPAY_DIRECT',kind:'own_acquirer',enabled:false,configured:true}]]);
 for(const route of externalRoutes){
  if(!route||typeof route!=='object'||!['STRIPE','BUCKZY'].includes(route.id))throw Error('UNSUPPORTED_EXTERNAL_ROUTE');
  if(routes.has(route.id))throw Error('DUPLICATE_EXTERNAL_ROUTE');
  routes.set(route.id,{id:route.id,kind:'external_processor',enabled:false,configured:route.configured===true});
 }
 return Object.freeze({acquirer:'AVISPay',acquiringBin:bin,mit,processorId,routes:Array.from(routes.values()),live:false});
}
function chooseAcquiringRoute(config,{routeId='AVISPAY_DIRECT'}={}){
 if(!config||!Array.isArray(config.routes))throw Error('INVALID_ACQUIRING_CONFIGURATION');
 if(!Object.hasOwn(ROUTES,routeId))throw Error('UNKNOWN_ACQUIRING_ROUTE');
 const route=config.routes.find(r=>r.id===routeId);
 if(!route||!route.configured)throw Error('ACQUIRING_ROUTE_NOT_CONFIGURED');
 // Routing proposal only. A signed, bank-approved adapter must activate the rail.
 return Object.freeze({routeId,kind:ROUTES[routeId].kind,processorState:'awaiting_authenticated_adapter',financialPosting:false,settlement:false});
}
function acquiringCapabilities(){
 return {module:'AVISPay Merchant Acquiring',model:'own_acquirer_plus_optional_external',ownAcquiringBin:'operator_configured',
  ownMIT:'operator_configured',routes:Object.entries(ROUTES).map(([id,v])=>({id,...v,live:false})),
  settlement:false,financialPosting:false};
}
module.exports={ROUTES,configureAcquiring,chooseAcquiringRoute,acquiringCapabilities};
