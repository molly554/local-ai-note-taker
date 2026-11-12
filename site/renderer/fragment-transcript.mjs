// Fictional speech drives the app's partial/final path, never a separate word animation.
export const fragmentLines = [
  {speaker:'Kara',text:'The launch page is ready for review.',track:'them',speakerColor:0},
  {speaker:'Ray',text:'We can publish Tuesday.',track:'them',speakerColor:1},
  {text:"I'll send Ray the asset list by Friday.",track:'me'},
].map((line,i)=>({...line,id:i+1,meetingId:'sample-meeting',startMs:10000+i*10000,endMs:14000+i*10000,hidden:false}))
const starts=[.8,2.65,4.05],ends=[2.35,3.8,5.95]
export function fragmentTranscriptAt(t){
  // Hidden final lines supply the known speaker before the live turn begins.
  const lines=fragmentLines.map((line,i)=>({...line,hidden:t<ends[i]}))
  const index=starts.findIndex((start,i)=>t>=start&&t<ends[i])
  if(index<0)return {lines,partial:{track:'them',startMs:0,text:'',words:[]}}
  const line=fragmentLines[index],all=line.text.split(' ')
  const count=Math.min(all.length,1+Math.floor((t-starts[index])/(ends[index]-starts[index])*(all.length-1)))
  const words=all.slice(0,count).map((text,i)=>({text,startMs:line.startMs+i*350,endMs:line.startMs+(i+1)*350}))
  return {lines,partial:{track:line.track,startMs:line.startMs,text:words.map(w=>w.text).join(' '),words}}
}
