import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import * as api from './lib/api'
import { resetStore, useSessionStore } from './stores/session'
import { resetLayout } from './stores/layout'
import { resetTerminals } from './stores/terminals'

vi.mock('./lib/api', async (original) => ({
 ...(await original<typeof import('./lib/api')>()),
 fetchHealth:vi.fn(),listSessions:vi.fn(),listRequests:vi.fn(),getQuotas:vi.fn(),fetchEvents:vi.fn(),
 listModels:vi.fn(),sendMessage:vi.fn(),getChanges:vi.fn(),getFileDiff:vi.fn(),uploadImage:vi.fn(),
}))
vi.mock('./lib/terminal',()=>({listTerminals:vi.fn().mockResolvedValue([])}))
vi.mock('./components/terminal/TerminalView',()=>({default:()=>null}))

beforeEach(()=>{
 vi.clearAllMocks()
 vi.stubGlobal('WebSocket',undefined)
 resetStore();resetLayout();resetTerminals()
 history.replaceState(null,'','/')
})

it('failed send must preserve the draft and attachments',async()=>{
 const session:api.Session={id:'s1',agent:'claude',cwd:'/p',status:'idle'}
 vi.mocked(api.fetchHealth).mockResolvedValue('online')
 vi.mocked(api.listSessions).mockResolvedValue([session])
 vi.mocked(api.listRequests).mockResolvedValue([])
 vi.mocked(api.getQuotas).mockResolvedValue([])
 vi.mocked(api.listModels).mockResolvedValue([])
 vi.mocked(api.fetchEvents).mockResolvedValue([])
 vi.mocked(api.sendMessage).mockRejectedValue(new Error('send failed'))
 vi.mocked(api.uploadImage).mockResolvedValue({id:'image.png',mimeType:'image/png'})
 useSessionStore.setState({sessions:[session],activeId:'s1'})
 render(<App />)
 const input=await screen.findByLabelText('message')
 fireEvent.change(input,{target:{value:'do not lose this'}})
 fireEvent.change(screen.getByLabelText('attach images'),{target:{files:[new File(['x'],'test.png',{type:'image/png'})]}})
 await screen.findByAltText('test.png')
 fireEvent.click(screen.getByRole('button',{name:'Send'}))
 await screen.findByText('send failed')
 expect.soft(input).toHaveValue('do not lose this')
 expect.soft(screen.queryByAltText('test.png')).toBeInTheDocument()
},20000)
