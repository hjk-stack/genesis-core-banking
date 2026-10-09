'use strict';
// Intentionally disabled market connectivity: no live order routing or secrets.
function validateVenueConfig(c){
 if(!c||!['FIX','REST','ISO20022'].includes(c.protocol)||typeof c.venue!=='string'||!/^[A-Za-z0-9_.:-]{2,80}$/.test(c.venue))throw Error('INVALID_CONFIG');
 if(c.enabled===true)throw Error('LIVE_ROUTING_DISABLED');
 if(c.apiKey||c.apiSecret||c.password||c.privateKey)throw Error('NO_SECRETS_IN_CONFIG');
 return {venue:c.venue,protocol:c.protocol,enabled:false};
}
class DisabledExchangeAdapter {
 constructor(c){this.config=validateVenueConfig(c)}
 async submitOrder(){throw Error('LIVE_ROUTING_DISABLED')}
 async cancelOrder(){throw Error('LIVE_ROUTING_DISABLED')}
 async getExecutionReports(){throw Error('EXCHANGE_CONNECTION_DISABLED')}
}
module.exports={validateVenueConfig,DisabledExchangeAdapter};
