import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {holderRegisterField,connectAccountHolderRegister,buildAccountOpeningRequest} from '../public/open-account-register.mjs';

const holders=[
 {user_id:'1',full_name:'AVISPay PLC',customer_number:'0000001',account_type:'BUSINESS'},
 {user_id:'2',full_name:'Existing personal',customer_number:'0000002',account_type:'PERSONAL'},
 {user_id:'3',full_name:'Other business',account_type:'BUSINESS'},
 {user_id:'4',full_name:'<script>not markup</script>',account_type:'PERSONAL'}
];
const fixture=()=>{
 const dom=new JSDOM(`<form>
  <label>Account type<select name="accountType"><option value="">Select type</option><option value="PERSONAL">Personal</option><option value="BUSINESS">Business</option><option value="COMMON">Common</option><option value="SUSPENSE">Suspense</option></select></label>
  ${holderRegisterField(holders)}
  <div data-open-account-name><label>Account name / holder<input name="fullName" required></label></div>
  <label>Currency<select name="currency"><option value="EUR">EUR</option><option value="USD">USD</option></select></label>
 </form>`);
 const form=dom.window.document.querySelector('form');
 connectAccountHolderRegister(form,holders);
 const change=field=>field.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
 const request=()=>buildAccountOpeningRequest(new dom.window.FormData(form),holders);
 return {dom,form,change,request};
};
test('Existing account-holder selection reads the register and submits the existing user ID',()=>{
 const {form,change,request}=fixture();
 const type=form.elements.accountType,holder=form.elements.holderUserId,name=form.elements.fullName;
 type.value='BUSINESS';change(type);
 assert.equal(holder.disabled,false);
 assert.equal(holder.querySelector('option[value="2"]').disabled,true);
 assert.equal(holder.querySelector('option[value="1"]').disabled,false);
 holder.value='1';change(holder);
 assert.equal(name.value,'AVISPay PLC');
 assert.equal(name.disabled,true);
 form.elements.currency.value='USD';
 assert.deepEqual(request(),{userId:'1',accountType:'BUSINESS',currencies:['USD']});
 assert.equal(form.querySelectorAll('script').length,0);
});
test('New holder registration and backoffice account creation keep existing workflow',()=>{
 const {form,change,request}=fixture();
 const type=form.elements.accountType,holder=form.elements.holderUserId,name=form.elements.fullName;
 type.value='PERSONAL';change(type);
 assert.throws(()=>request(),/Select an account holder/);
 holder.value='NEW';change(holder);name.value='New personal';
 assert.equal(name.disabled,false);assert.equal(name.required,true);
 assert.deepEqual(request(),{fullName:'New personal',accountType:'PERSONAL',currencies:['EUR']});
 type.value='SUSPENSE';change(type);
 assert.equal(holder.disabled,true);assert.equal(form.querySelector('[data-open-account-holder]').hidden,true);
 name.value='Review suspense';
 assert.deepEqual(request(),{fullName:'Review suspense',accountType:'SUSPENSE',currencies:['EUR']});
});
test('Changing account type cannot reuse a holder of a different type or forge a holder ID',()=>{
 const {dom,form,change,request}=fixture();
 form.elements.accountType.value='BUSINESS';change(form.elements.accountType);
 form.elements.holderUserId.value='1';change(form.elements.holderUserId);
 form.elements.accountType.value='PERSONAL';change(form.elements.accountType);
 assert.equal(form.elements.holderUserId.value,'');
 form.elements.holderUserId.value='2';change(form.elements.holderUserId);
 assert.deepEqual(request(),{userId:'2',accountType:'PERSONAL',currencies:['EUR']});
 const fake=new dom.window.FormData(form);
 fake.set('holderUserId','99999');
 assert.throws(()=>buildAccountOpeningRequest(fake,holders),/valid registered/);
});
