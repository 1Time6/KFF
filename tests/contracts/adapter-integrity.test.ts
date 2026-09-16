import {copyFileSync,mkdirSync,mkdtempSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {adapterImplementationDigest,adapterSourceHashes} from '../../packages/core/src/artifacts';

// These modules participate in real reads and must invalidate already-approved snapshots.
it.each(['packages/adapters/src/facebook-browser-page.ts','packages/adapters/src/facebook-inbox-directory-dom.ts'])('changes the execution digest when only %s changes', file=>{
  const taskRoot=mkdtempSync(path.join(tmpdir(),'kff-adapter-integrity-'));
  try{
    const sourceHashes=adapterSourceHashes(process.cwd(),'facebook');
    expect(sourceHashes).toHaveProperty(file);
    for(const source of Object.keys(sourceHashes)){
      const destination=path.join(taskRoot,source);mkdirSync(path.dirname(destination),{recursive:true});copyFileSync(source,destination);
    }
    const before=adapterImplementationDigest(taskRoot,'facebook');
    expect(before).toBe(adapterImplementationDigest(process.cwd(),'facebook'));
    appendFileSync(path.join(taskRoot,file),'\n// Isolated changed implementation sentinel.\n');
    expect(adapterImplementationDigest(taskRoot,'facebook')).not.toBe(before);
    expect(adapterImplementationDigest(process.cwd(),'facebook')).toBe(before);
  }finally{
    const resolved=path.resolve(taskRoot),allowed=path.resolve(tmpdir())+path.sep;
    if(!resolved.startsWith(allowed)||!path.basename(resolved).startsWith('kff-adapter-integrity-'))throw Error('Unexpected isolated test directory');
    rmSync(resolved,{recursive:true,force:true});
  }
});
