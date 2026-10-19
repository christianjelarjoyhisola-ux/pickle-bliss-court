import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createClient } from '@supabase/supabase-js';
const source = readFileSync(new URL('../supabase-config.js', import.meta.url), 'utf8');
const token = ['header', Buffer.from(JSON.stringify({role:'authenticated',exp:Math.floor(Date.now()/1000)+3600,sub:'diagnostic-user'})).toString('base64url'),'signature'].join('.');
const session = JSON.stringify({access_token:token,refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id:'diagnostic-user'}});
for (const customer of [true, false]) {
 const requests=[];
 const storage = new Map([['sb-ikqfszhqpyayzroccegi-auth-token',session]]);
 const store={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 const clients=[];
 const context={console,URLSearchParams,structuredClone,location:{hostname:'pickleblisscourt.com',search:''},document:{currentScript:{dataset:customer?{customerBookings:'true'}:{}}},localStorage:store,sessionStorage:store};
 context.window=context;
 context.supabase={createClient:(url,key,options={})=>{
  const client=createClient(url,key,{...options,auth:{autoRefreshToken:false,detectSessionInUrl:false,storage:store,...options.auth},global:{fetch:async(url,options={})=>{
   requests.push({url:String(url),method:options.method,headers:new Headers(options.headers)});
   return new Response(JSON.stringify([]),{status:200,headers:{'Content-Type':'application/json'}});
  }}});
  clients.push(client);return client;
 }};
 vm.runInNewContext(source,context);
 assert.equal((await clients[0].auth.getSession()).data.session.access_token,token,'saved dashboard session is loaded');
 await context.DB.addBooking({ref:'TEST',courtId:'c1',date:'2026-10-20',slots:[6],status:'verifying',createdAt:new Date().toISOString(),total:165});
 await context.DB.updateBooking('TEST',{status:'cancelled',paymentStatus:'rejected'});
 const writes=requests.filter(r=>['POST','PATCH'].includes(r.method));
 assert.equal(writes.length,2);
 for(const request of writes) assert.equal(request.headers.get('authorization'),`Bearer ${customer?'sb_publishable_o4zS7E8WD-XnQWD9MQRtCA_6gPJf4-I':token}`);
 assert.equal((await clients[0].auth.getSession()).data.session.access_token,token,'customer checkout preserves dashboard login');
 assert.equal(storage.get('sb-ikqfszhqpyayzroccegi-auth-token'),session);
 console.log(customer?'PASS customer insert/cancel excludes saved dashboard JWT':'PASS admin insert/update retains authenticated JWT');
 for(const client of clients) await client.auth.stopAutoRefresh();
}
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
assert.match(html,/<script[^>]+supabase-config\.js\?v=20261019-booking-session-v1[^>]+data-customer-bookings="true"/);
assert.doesNotMatch(readFileSync(new URL('../admin.html',import.meta.url),'utf8'),/data-customer-bookings="true"/);
console.log('PASS customer/admin page configuration');
