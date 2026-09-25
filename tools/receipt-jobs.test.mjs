import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Execute the real migration and procedures against isolated PostgreSQL/WASM.
// Only the pre-existing tables are reduced to the columns used by this change.
const pg = new PGlite();
await pg.exec(`
 create role anon; create role authenticated; create role service_role;
 create table bookings(ref text primary key, booking_group_ref text, status text, payment_status text,
 gcash_ref text, created_at timestamptz, total numeric, downpayment numeric,
 receipt_image_url text, receipt_image_hash text, receipt_status text, receipt_flags text[],
 receipt_extracted jsonb, receipt_confidence numeric, receipt_verified_at timestamptz,receipt_phash text);
 create table receipt_staged_uploads(id uuid primary key default gen_random_uuid(),booking_ref text,
 status text,storage_path text,image_hash text,storage_deleted_at timestamptz);
 create table receipt_verifications(id bigserial primary key,booking_ref text,result text,flags text[],extracted jsonb,
 confidence numeric,image_hash text,phash text,storage_path text,raw_ocr_text text);
`);
await pg.exec(readFileSync(new URL('../supabase/migrations/20260925090000_receipt_verification_jobs.sql', import.meta.url),'utf8'));
const query = async (sql, args=[]) => (await pg.query(sql,args)).rows;
async function seed(ref, status='pending', pay='for_verification') {
  await pg.query(`insert into bookings(ref,status,payment_status,gcash_ref,created_at,total,downpayment,receipt_image_url,receipt_image_hash,receipt_status)
    values($1,$2,$3,'9045391205507','2026-09-24T07:39:00Z',330,330,$1,'hash','none')`,[ref,status,pay]);
  const [upload] = await query(`insert into receipt_staged_uploads(booking_ref,status,storage_path,image_hash) values($1,'staged',$1,'hash') returning id`,[ref]);
  await pg.query(`update receipt_staged_uploads set status='consumed' where id=$1`,[upload.id]);
  const [job]=await query(`select * from receipt_verification_jobs where upload_id=$1`,[upload.id]);
  return {upload,job};
}
async function claim(job) { return (await query('select claim_receipt_job($1) as value',[job.id]))[0].value; }
async function finish(job, status='auto_approved', amount=330) {
  const audit={result:status,flags:status==='manual_review'?['AMOUNT_MISMATCH']:[],extracted:{amount},confidence:0.9,
    typed_ref:'9045391205507',booking_created_at:'2026-09-24T07:39:00Z',raw_ocr_text:'receipt'};
  const metadata={receipt_status:status,receipt_flags:audit.flags,receipt_extracted:audit.extracted,receipt_confidence:0.9,
    receipt_verified_at:'2026-09-25T07:00:00Z',receipt_phash:'abc',confirmation:{email:'test@example.invalid',bookingRef:job.booking_ref}};
  return (await query('select finish_receipt_job($1,$2,$3,$4,$5) as value',
    [job.id,job.lease_token,JSON.stringify(audit),JSON.stringify(metadata),JSON.stringify({status,ok:true})]))[0].value;
}

const first=await seed('NEW');
assert.equal(first.job.status,'queued','finalization enqueues transactionally');
const leased=await claim(first.job);
assert.equal((await claim(first.job)).status,'busy','browser and worker cannot both process');
await finish(leased);
assert.equal((await query("select status from bookings where ref='NEW'"))[0].status,'confirmed');
assert.equal((await claim(first.job)).status,'done','completed work is replayed, not rerun');
await assert.rejects(()=>finish(leased),/lease expired/);
assert.equal((await query('select count(*)::int n from receipt_verifications'))[0].n,1,'only one audit committed');

for(const [state,pay] of [['confirmed','paid'],['completed','paid'],['cancelled','rejected']]) {
  const {job}=await seed(state,state,pay);
  const j=await claim(job);
  const result=await finish(j,'manual_review',200);
  assert.equal(result.preservedApproval,true);
  assert.deepEqual((await query('select status,payment_status from bookings where ref=$1',[state]))[0],{status:state,payment_status:pay});
}
const short=await seed('SHORT'); await finish(await claim(short.job),'manual_review',200);
assert.equal((await query("select status from bookings where ref='SHORT'"))[0].status,'pending');

const changed=await seed('CHANGED'); const cj=await claim(changed.job);
await query("update bookings set receipt_image_url='new-proof' where ref='CHANGED'");
await assert.rejects(()=>finish(cj),/receipt changed/);
assert.equal((await query("select count(*)::int n from receipt_verifications where booking_ref='CHANGED'"))[0].n,0);

const race=await seed('ADMIN-RACE'); const rj=await claim(race.job);
await query("update bookings set status='confirmed',payment_status='paid' where ref='ADMIN-RACE'");
await finish(rj,'manual_review');
assert.equal((await query("select payment_status from bookings where ref='ADMIN-RACE'"))[0].payment_status,'paid');

const exhausted=await seed('RETRY');
for(let i=1;i<=3;i++) {
  const j=await claim(exhausted.job); assert.equal(j.attempts,i);
  await query('select fail_receipt_job($1,$2,$3)',[j.id,j.lease_token,'OCR timeout']);
  await query("update receipt_verification_jobs set available_at=now()-interval '1 second' where id=$1",[j.id]);
}
assert.equal((await claim(exhausted.job)).status,'failed');
const actor='00000000-0000-0000-0000-000000000001', request='00000000-0000-0000-0000-000000000002';
const enqueue=async()=> (await query('select enqueue_receipt_reread($1,$2,$3) id',[exhausted.upload.id,actor,request]))[0].id;
assert.equal(await enqueue(),await enqueue(),'admin request is idempotent');
assert.notEqual(await enqueue(),exhausted.job.id,'explicit reread starts fresh bounded attempts');

const stale=await seed('LEASE'); const old=await claim(stale.job);
await query("update receipt_verification_jobs set lease_until=now()-interval '1 second' where id=$1",[old.id]);
const next=await claim(stale.job); assert.notEqual(next.lease_token,old.lease_token);
await assert.rejects(()=>finish(old),/lease expired/);
await finish(next);

const notices=await query('select * from receipt_confirmation_outbox');
assert.equal(notices.length,2,'only new approvals enqueue confirmations, never protected approvals or underpayments');
const [notice]=notices;
const claimNotice=async()=> (await query('select claim_receipt_confirmation($1) value',[notice.id]))[0].value;
const nc=await claimNotice(); assert.equal(nc.status,'processing');
assert.equal((await claimNotice()).status,'busy','email delivery is leased');
await query("update receipt_confirmation_outbox set lease_until=now()-interval '1 second' where id=$1",[notice.id]);
const nc2=await claimNotice();
assert.equal(nc2.upload_id,nc.upload_id,'email idempotency key remains stable');
assert.deepEqual(nc2.payload,nc.payload,'email retry payload remains frozen');
await query("update receipt_confirmation_outbox set lease_until=now()-interval '1 second',created_at=now()-interval '24 hours' where id=$1",[notice.id]);
assert.equal((await claimNotice()).status,'failed','never resend outside provider idempotency window');
const adminJob=await claim({id:await enqueue()});
await finish(adminJob);
assert.equal((await query('select count(*)::int n from receipt_confirmation_outbox'))[0].n,2,'admin re-read does not resend customer email');

await pg.exec('set role anon');
await assert.rejects(()=>query('select * from receipt_verification_jobs'),/permission denied/);
await assert.rejects(()=>query('select claim_receipt_job($1)',[first.job.id]),/permission denied/);
await assert.rejects(()=>query('select * from receipt_confirmation_outbox'),/permission denied/);
await assert.rejects(()=>query('select claim_receipt_confirmation($1)',[notice.id]),/permission denied/);
await pg.exec('reset role');
await pg.close();
console.log('Receipt job integration checks passed: enqueue, leases, idempotency, protected states, concurrent admin approval, replacement proof, retries, expired leases and permissions.');
