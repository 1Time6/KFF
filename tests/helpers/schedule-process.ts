import {prepareScheduleOne} from '../../packages/core/src/schedules';
const boundary=process.argv[2];
function hold(){process.send?.({barrier:boundary});return new Promise<void>(()=>{setInterval(()=>{},1000);});}
await prepareScheduleOne({beforeCommit:boundary==='before'?hold:undefined});
if(boundary==='after')await hold();
