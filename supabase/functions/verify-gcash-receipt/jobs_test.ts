import { runReceiptJobRequest } from "./jobs.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const reply = (body: unknown, status = 200) => Response.json(body, {status});
const request = (token = "") => new Request("https://example.invalid/verify", {method:"POST",headers:{authorization:token}});
function fakeDb(tables: Record<string, unknown>, claimed: unknown = {status:"busy"}) {
  const calls: string[]=[];
  const db = {
    calls, auth:{getUser:()=>Promise.resolve({data:{user:{id:"admin"}}})},
    from: (table: string) => {
      const chain: any={};
      for (const method of ["select","eq","is","order","limit"]) chain[method]=()=>chain;
      chain.single=chain.maybeSingle=()=>Promise.resolve({data:tables[table]});
      return chain;
    },
    rpc: (name: string) => {calls.push(name);return Promise.resolve({data:name==="claim_receipt_job"?claimed:"new-id"});},
  };
  return db;
}
const hash = async()=>"hash";

Deno.test("customer capability is required before claiming any work",async()=>{
  const db=fakeDb({}); let ran=false;
  const r=await runReceiptJobRequest(request(),db,{action:"verify_staged"},hash,async()=>{ran=true;return reply({});},reply);
  assertEquals(r.status,403);assertEquals(ran,false);assertEquals(db.calls,[]);
});
Deno.test("non-admin cannot enqueue a re-read",async()=>{
  const db=fakeDb({accounts:{role:"customer"}});
  const r=await runReceiptJobRequest(request("Bearer user"),db,{action:"reread"},hash,async()=>reply({}),reply);
  assertEquals(r.status,403);assertEquals(db.calls,[]);
});
Deno.test("service action rejects customer tokens",async()=>{
  const db=fakeDb({});
  const r=await runReceiptJobRequest(request("Bearer not-service"),db,{action:"process_job"},hash,async()=>reply({}),reply);
  assertEquals(r.status,401);assertEquals(db.calls,[]);
});
Deno.test("worker accepts either configured backend key when both exist",async()=>{
  const previous=[Deno.env.get('SERVICE_ROLE_KEY'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')];
  try {
    Deno.env.set('SERVICE_ROLE_KEY','custom');Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','builtin');
    for(const token of ['custom','builtin']) {
      const db=fakeDb({});
      const r=await runReceiptJobRequest(request(`Bearer ${token}`),db,{action:'process_job',jobId:'job'},hash,async()=>reply({}),reply);
      assertEquals(r.status,202);assertEquals(db.calls,['claim_receipt_job']);
      const apiDb=fakeDb({});
      const apiRequest=new Request('https://example.invalid/verify',{method:'POST',headers:{apikey:token}});
      const apiResult=await runReceiptJobRequest(apiRequest,apiDb,{action:'process_job',jobId:'job'},hash,async()=>reply({}),reply);
      assertEquals(apiResult.status,202);
    }
  } finally {
    for(const [i,name] of ['SERVICE_ROLE_KEY','SUPABASE_SERVICE_ROLE_KEY'].entries()) {
      if(previous[i]===undefined)Deno.env.delete(name);else Deno.env.set(name,previous[i]!);
    }
  }
});
Deno.test("completed customer request replays outcome without OCR",async()=>{
  const db=fakeDb({receipt_staged_uploads:{id:"upload"},receipt_verification_jobs:{id:"job"}},
    {status:"done",outcome:{status:"manual_review",notificationsManaged:true}});
  let ran=false;
  const r=await runReceiptJobRequest(request(),db,{action:"verify_staged"},hash,async()=>{ran=true;return reply({});},reply);
  assertEquals(await r.json(),{status:"manual_review",notificationsManaged:true,replayed:true});assertEquals(ran,false);
});
Deno.test("modern project secret API key authenticates on apikey without a JWT",async()=>{
  const previous=Deno.env.get('SUPABASE_SECRET_KEYS');
  try {
    Deno.env.set('SUPABASE_SECRET_KEYS',JSON.stringify({default:'sb_secret_test'}));
    const req=new Request('https://example.invalid/verify',{method:'POST',headers:{apikey:'sb_secret_test'}});
    const db=fakeDb({});
    const result=await runReceiptJobRequest(req,db,{action:'process_job',jobId:'job'},hash,async()=>reply({}),reply);
    assertEquals(result.status,202);assertEquals(db.calls,['claim_receipt_job']);
  } finally { if(previous===undefined)Deno.env.delete('SUPABASE_SECRET_KEYS');else Deno.env.set('SUPABASE_SECRET_KEYS',previous); }
});
Deno.test("provider failure persists retry; client fields do not become job capability",async()=>{
  const db=fakeDb({receipt_staged_uploads:{id:"upload"},receipt_verification_jobs:{id:"job"}},
    {id:"job",status:"processing",booking_ref:"CANONICAL",upload_id:"upload",lease_token:"lease"});
  const r=await runReceiptJobRequest(request(),db,{action:"verify_staged",bookingRef:"CLIENT",lease_token:"fake"},hash,
    async(req,job)=>{assertEquals(job.lease_token,"lease");assertEquals((await req.json()).bookingRef,"CANONICAL");return reply({error:"OCR unavailable"},503);},reply);
  assertEquals(r.status,503);assertEquals(db.calls,["claim_receipt_job","fail_receipt_job"]);
});
