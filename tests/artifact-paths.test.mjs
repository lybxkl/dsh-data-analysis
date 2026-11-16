import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {artifactPath,readFigures,readModels,readQaReports,readVerify,analysisFile,withReadCache} from '../src/audit.js';
import {productionReceipt,currentProductionReceipt} from '../src/gate-production.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsa-artifact-paths-'));
const write=(rel,value)=>{const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
try{
  write('research_registry.json',{artifact_paths:{'output/chart_pack/chart_manifest.csv':'output/custom/charts.csv','output/models':'output/custom/models','output/qa/qa_report.json':'output/quality','output/verify/number_issues.csv':'output/numbers/issues.csv','output/dataset/analysis.csv':'output/custom/data.csv'}});
  write('output/custom/charts.csv','id,png,n,width_cm,dpi,status\nF1,f.png,3,15,600,ok\n');write('output/custom/f.png','fixture');
  write('output/custom/models/coef_M1.csv','model,term,b,n\nM1,x,2,3\n');
  write('output/quality',{error_count:0,warning_count:1});
  write('output/numbers/issues.csv','severity,check,where,detail\n');write('output/custom/data.csv','id,in_analysis\na,1\n');
  withReadCache(()=>{
    const figures=readFigures(root);assert.equal(figures.rows.length,1);assert.equal(figures.rows[0].pngExists,true);assert.equal(figures.file,'output/custom/charts.csv');
    assert.equal(readModels(root).dir,'output/custom/models');
    assert.equal(readQaReports(root)[0].json.warning_count,1);
    assert.equal(readVerify(root).file,'output/numbers/issues.csv');
    assert.equal(analysisFile(root).rel,'output/custom/data.csv');
  });
  write('script.py','# Actual operation code binding fixture\n');
  write('output/audit/result.csv','old');write('output/audit/report.md','old metadata');
  const step={scriptAbs:path.join(root,'script.py'),argv:[path.join(root,'script.py'),'--out-dir','output/audit'],produces:['output/audit/result.csv']};
  const production=productionReceipt(root,'audit','repeat-run',[step]);
  write('output/audit/result.csv','new');write('output/audit/report.md','new metadata');write('output/audit/history-new.csv','new history');
  production.stepFinished(step,0);assert.equal(production.finish('ok').status,'completed');
  assert.equal(currentProductionReceipt(root,{stage:'audit',runId:'repeat-run',requiredOutputs:['output/audit/result.csv']}).ok,true);
  write('script.py','# changed implementation\n');
  assert.equal(currentProductionReceipt(root,{stage:'audit',runId:'repeat-run'}).ok,false);
  write('research_registry.json',{artifact_paths:{'output/models':'../outside'}});
  assert.throws(()=>artifactPath(root,'output/models/coef.csv'));
  console.log('PASS Declared custom artifact paths work in panel readers and preserve physical boundaries');
}finally{fs.rmSync(root,{recursive:true,force:true});}
