import http from 'node:http'
const port = Number(process.argv[2])
let generation = 0
http.createServer(async (req, res) => {
 if(req.url === '/health'){res.end('ok');return}
 if(req.headers.authorization !== 'Bearer e2e-native'){res.writeHead(401).end();return}
 if(req.url === '/models'){
  generation++
  res.setHeader('Content-Type','application/json')
  res.end(JSON.stringify({data:[{id:'test/native',name:'Native test',context_length:64000,architecture:{input_modalities:['text','image']}},{id:`test/fresh-${generation}`,name:`Fresh ${generation}`}]}));return
 }
 let raw='';for await(const chunk of req)raw+=chunk
 const body=JSON.parse(raw)
 const msgs=body.messages
 const userIndex=msgs.findLastIndex(m=>m.role==='user')
 const text=msgs[userIndex]?.content ?? ''
 const results=msgs.slice(userIndex+1).filter(m=>m.role==='tool')
 if(text==='native slow'){await new Promise(resolve=>{const timer=setTimeout(resolve,10000);res.on('close',()=>{clearTimeout(timer);resolve()})});if(res.destroyed)return}
 let delta={content:`native: ${typeof text==='string'?text:'image received'}`},finish='stop'
 const call=(name,args)=>{delta={tool_calls:[{index:0,id:'call-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}}]};finish='tool_calls'}
 if(typeof text==='string' && text.startsWith('/chart-probe ')) {
  const instructions=msgs.filter(m=>m.role==='system'||m.role==='developer').map(m=>m.content).join('\n')
  const skillPath=instructions.match(/- \/chart-probe: .*\(instructions: (.+)\)/)?.[1]
  if(!results.length && skillPath)call('read',{path:skillPath})
  else delta={content:results.map(r=>r.content).join('\n') || 'skill mapping missing'}
 }
 if(text==='native permission'&&!results.length)call('write',{path:'native-output.txt',content:'written'})
 if(text==='native question'&&!results.length)call('ask_user',{question:'Choose a colour',options:['Blue','Green']})
 if(text==='native delegation boundary') {
  if(!results.length)call('spawn_agent',{task:'native executor check',title:'Bounded executor'})
  else if(results.length===1)call('wait_agent',{id:JSON.parse(results[0].content).id})
 }
 if(text==='native executor check') {
  const canSpawn=body.tools?.some(t=>t.function?.name==='spawn_agent')
  const instructions=msgs.filter(m=>m.role==='system'||m.role==='developer').map(m=>m.content).join('\n')
  delta={content: !canSpawn && instructions.includes('Complete the assigned task yourself') ? 'executor boundary verified' : 'executor boundary missing'}
 }
 if(text==='native spawn'){
  if(!results.length)call('spawn_agent',{task:'child task',title:'Native child'})
  else if(results.length===1)call('wait_agent',{id:JSON.parse(results[0].content).id})
 }
 if(text==='native plan'&&!results.length)call('update_plan',{plan:[{step:'Read the code',status:'completed'},{step:'Write the fix',status:'in_progress'}]})
 if(text==='native foreground'){
  if(!results.length)call('spawn_agent',{task:'child task',title:'Foreground child'})
  else delta={content:`parent got: ${JSON.parse(results[0].content).result}`}
 }
 if(text==='native background'){
  if(!results.length)call('spawn_agent',{task:'child task',title:'Background child',background:true})
  else delta={content:`launched: ${JSON.parse(results[0].content).status}`}
 }
 if(typeof text==='string'&&text.startsWith('Background agent "Background child" completed'))delta={content:text.includes('native: child task')?'parent woke with the child result':'parent woke without the result'}
 const system=msgs.filter(m=>m.role==='system'||m.role==='developer').map(m=>m.content).join('\n')
 if(system.startsWith('You audit the progress'))delta={content:JSON.stringify(text.includes('goal step 2')?{verdict:'complete',note:'probe verified'}:{verdict:'continue',note:'one step left'})}
 else if(typeof text==='string'&&text.startsWith('Work toward the active session goal.'))delta={content:`goal step ${Number(text.match(/Continuations used: (\d+)/)[1])+1}`}
 res.setHeader('Content-Type','text/event-stream')
 res.end(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`)
}).listen(port,'127.0.0.1')
