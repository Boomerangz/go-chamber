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
 if(text==='native permission'&&!results.length)call('write',{path:'native-output.txt',content:'written'})
 if(text==='native question'&&!results.length)call('ask_user',{question:'Choose a colour',options:['Blue','Green']})
 if(text==='native spawn'){
  if(!results.length)call('spawn_agent',{task:'child task',title:'Native child'})
  else if(results.length===1)call('wait_agent',{id:JSON.parse(results[0].content).id})
 }
 res.setHeader('Content-Type','text/event-stream')
 res.end(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`)
}).listen(port,'127.0.0.1')
