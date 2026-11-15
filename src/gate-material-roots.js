/** Host-owned root registration. Absolute locations never enter a gate report. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {verifyMounts,derivedRoot,derivedMountName} from './sources.js';
import {safePath,strictJson} from './gate-report.js';

export function syncMaterialRoots(root,project,sources,cacheDir='') {
  const mounts=project.materials?.mounts||[];
  if(verifyMounts(root,{mounts}).some(r=>r.status!=='ok'))throw new Error('资料挂载失效，先修复挂载再登记体检根');
  const file=safePath(root,'.workbench/gates/roots.json');
  let previous={roots:{}};
  if(fs.existsSync(file))previous=strictJson(fs.readFileSync(file,'utf8'));
  const roots=Object.fromEntries(Object.entries(previous.roots||{}).filter(([id])=>!id.startsWith('material:host-')));
  for(const mount of mounts){
    const source=sources.find(s=>s.id===mount.sourceId);
    if(!source)throw new Error('挂载未关联已登记资料来源');
    const id='material:host-'+crypto.createHash('sha256').update(JSON.stringify([mount.sourceId,mount.as])).digest('hex').slice(0,24);
    roots[id]=fs.realpathSync(path.resolve(source.path,mount.entry||''));
    if(cacheDir){
      const derived=path.join(root,'data',derivedMountName(mount));
      if(fs.existsSync(derived)){
        const expected=path.resolve(derivedRoot(cacheDir,mount.sourceId),mount.entry||'');
        if(fs.realpathSync(derived)!==fs.realpathSync(expected))throw Error('识别稿挂载目标与宿主缓存登记不符');
        roots[id+'-derived']=fs.realpathSync(expected);
      }
    }
  }
  const value={schema:'dsa.gate-roots/1',roots};
  if(JSON.stringify(previous)===JSON.stringify(value))return;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=`${file}.${crypto.randomUUID()}.tmp`;
  try{fs.writeFileSync(temporary,JSON.stringify(value));fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
