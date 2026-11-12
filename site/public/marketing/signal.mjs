export function speechSignal({frames,step,duration}){
  // Monotone cubic interpolation preserves measured peaks without sharp velocity changes.
  const slopes=frames.map((frame,index)=>frame.map((value,channel)=>{
    const before=value-frames[(index+frames.length-1)%frames.length][channel];
    const after=frames[(index+1)%frames.length][channel]-value;
    return before*after>0?2*before*after/(before+after):0;
  }));
  return time=>{
    const at=(time%duration)/step,a=Math.floor(at),b=(a+1)%frames.length,blend=at-a;
    const t2=blend*blend,t3=t2*blend;
    const sample=frames[a].map((value,index)=>(2*t3-3*t2+1)*value+(t3-2*t2+blend)*slopes[a][index]+(-2*t3+3*t2)*frames[b][index]+(t3-t2)*slopes[b][index]);
    const ambient=.028+.006*Math.sin(time*.83)+.004*Math.sin(time*1.37+.7);
    return {level:ambient+(1-ambient)*sample[0],bands:sample.slice(1)};
  };
}
