// Read the saved simulation timeline without changing the plan or its evidence.
export function sampleTrack(path, time) {
  let index=0;
  while(index+1<path.length && path[index+1][0]<=time)index++;
  const a=path[index],b=path[Math.min(index+1,path.length-1)];
  const f=b[0]===a[0]?0:Math.max(0,Math.min(1,(time-a[0])/(b[0]-a[0])));
  return a.map((value,key)=>value+(b[key]-value)*f);
}

export function sequenceAt(results, elapsed) {
  let index=0,time=Math.max(0,elapsed),duration;
  for(;;){
    const result=results[index];
    duration=result.servo_trajectory?.at(-1)?.[0] ?? result.trajectories.stick.at(-1)[0];
    if(time<duration || index===results.length-1)break;
    time-=duration;index++;
  }
  return {index,time:Math.min(time,duration),complete:index===results.length-1&&time>=duration};
}
