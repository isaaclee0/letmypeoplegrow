const { test } = require('node:test');
const assert = require('node:assert/strict');
const router = require('./reports');
const { verifyToken } = require('../middleware/auth');
const service = require('../services/visitorFollowUp');
const logger = require('../config/logger');
logger.exceptions?.unhandle(); logger.rejections?.unhandle();
const route = router.stack.find(layer => layer.route?.path === '/visitor-follow-up').route;
async function request(user, query = {}) {
  let status = 200, body;
  const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
  const req = { user, query };
  let allowed = false;
  route.stack[0].handle(req,res,()=>{allowed=true;});
  if (allowed) await route.stack[1].handle(req,res);
  return {status,body};
}
test('visitor actions are authenticated and restricted to leaders',async()=>{
  assert.equal(router.stack[0].handle,verifyToken);
  assert.equal((await request(null)).status,401);
  assert.equal((await request({role:'attendance_taker',church_id:'a'})).status,403);
});
test('route derives church from authenticated user, validates IDs, and passes display filters',async t=>{
  const original=service.getVisitorFollowUp;
  t.after(()=>{service.getVisitorFollowUp=original;});
  const calls=[];
  service.getVisitorFollowUp=async(churchId,options)=>{calls.push({churchId,options});return {groups:[]};};
  for (const role of ['admin','coordinator']) {
    assert.equal((await request({role,church_id:'a'},{gatheringIds:'1,2',churchId:'b'})).status,200);
  }
  assert.deepEqual(calls,[{churchId:'a',options:{gatheringIds:[1,2]}},{churchId:'a',options:{gatheringIds:[1,2]}}]);
  for (const gatheringIds of ['-1','0','1,x','1.5',['1'], '9007199254740992']) {
    assert.equal((await request({role:'admin',church_id:'a'},{gatheringIds})).status,400);
  }
  assert.equal(calls.length,2);
});
