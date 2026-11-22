import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showSessionDetails } from './pane'
const headers = { Authorization: `Bearer ${token}` }

test('Native catalog refresh, streaming, approval, question, fork and resume', async ({ page }) => {
 const cwd=realpathSync(mkdtempSync(path.join(tmpdir(),'native-e2e-')))
 await page.goto(`/?token=${token}`)
 await openNewSession(page)
 await page.getByRole('radio',{name:'Native',exact:true}).click()
 await page.getByLabel('Working directory').fill(cwd)
 await page.getByRole('button',{name:'New session',exact:true}).click()
 await expect(page.getByLabel('Message')).toBeVisible()
 await showSessionDetails(page)
 await page.getByRole('button',{name:'Model: Default model'}).click()
 await expect(page.getByRole('radio',{name:/Native test/})).toBeVisible()
 const before=await page.getByRole('radio',{name:/Fresh /}).textContent()
 await page.getByRole('button',{name:'Refresh models'}).click()
 await expect(page.getByRole('radio',{name:/Fresh /})).not.toHaveText(before!)
 await page.getByRole('radio',{name:/Native test/}).click()
 const send=async(text:string)=>{await page.getByLabel('Message').fill(text);await page.getByRole('button',{name:'Send',exact:true}).click()}
 await send('hello')
 await expect(page.getByText('native: hello',{exact:true})).toBeVisible()
 await send('native permission')
 await page.locator('.chat .request').getByRole('button',{name:'Allow',exact:true}).click()
 await expect(page.getByText('native: native permission',{exact:true})).toBeVisible()
 await send('native question')
 const question=page.locator('.chat .request.question')
 await question.getByLabel('Blue',{exact:false}).check()
 await question.getByRole('button',{name:/Submit/}).click()
 await expect(page.getByText('native: native question',{exact:true})).toBeVisible()
 await page.reload()
 await expect(page.getByText('native: hello',{exact:true})).toBeVisible()
 await showSessionDetails(page)
 await page.getByRole('button',{name:'Fork',exact:true}).click()
 const previous=page.url()
 await page.getByRole('button',{name:'Create fork',exact:true}).click()
 await expect(page).not.toHaveURL(previous)
 await expect(page.getByText('native: hello',{exact:true})).toBeVisible()
 await expect(page.getByLabel('Message')).toHaveValue('')
 await send('branch')
 await expect(page.getByText('native: branch',{exact:true})).toBeVisible()
})

test('Native child sessions and interrupt',async({page})=>{
 const cwd=realpathSync(mkdtempSync(path.join(tmpdir(),'native-child-')))
 const response=await page.request.post('/api/sessions',{headers,data:{agent:'native',cwd,model:'openrouter:test/native'}})
 expect(response.ok()).toBe(true)
 const session=await response.json()
 await page.goto(`/s/${session.id}?token=${token}`)
 await page.getByLabel('Message').fill('native spawn')
 await page.getByRole('button',{name:'Send',exact:true}).click()
 await expect(page.getByText('native: native spawn',{exact:true})).toBeVisible()
 const sessions=await (await page.request.get('/api/sessions',{headers})).json()
 const child=sessions.find((s:{parentId?:string})=>s.parentId===session.id)
 expect(child).toBeTruthy()
 await page.goto(`/s/${child.id}?token=${token}`)
 await expect(page.getByText('native: child task',{exact:true})).toBeVisible()
 await page.goto(`/s/${session.id}?token=${token}`)
 await page.getByLabel('Message').fill('native slow')
 await page.getByRole('button',{name:'Send',exact:true}).click()
 await page.getByRole('button',{name:'Stop',exact:true}).click()
 await expect(page.locator('.chat-meta .status')).toHaveText('idle')
 await page.getByLabel('Message').fill('native permission')
 await page.getByRole('button',{name:'Send',exact:true}).click()
 await expect(page.locator('.chat .request')).toBeVisible()
 await page.getByRole('button',{name:'Stop',exact:true}).click()
 await expect(page.locator('.chat .request')).toHaveCount(0)
 await expect(page.locator('.chat-meta .status')).toHaveText('idle')
 await page.getByLabel('Message').fill('after stop')
 await page.getByRole('button',{name:'Send',exact:true}).click()
 await expect(page.getByText('native: after stop',{exact:true})).toBeVisible()
})


test('Native completes slash skills and reads the selected instructions', async ({ page, isMobile }) => {
 const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-skills-')))
 try {
  const skillDir = path.join(cwd, '.agents', 'skills', 'chart-probe')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: chart-probe\ndescription: Plot the test metrics\n---\nchart-skill-loaded\n')
  const response = await page.request.post('/api/sessions', { headers, data: { agent: 'native', cwd, model: 'openrouter:test/native' } })
  expect(response.ok()).toBe(true)
  const session = await response.json()
  await page.goto(`/s/${session.id}?token=${token}`)
  const box = page.getByLabel('Message')
  await box.fill('/chart')
  await expect(page.getByRole('option', { name: /\/chart-probe/ })).toBeVisible()
  if (isMobile) await page.getByRole('option', { name: /\/chart-probe/ }).click()
  else await box.press('Tab')
  await expect(box).toHaveValue('/chart-probe ')
  await box.fill('/chart-probe plot results')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: 'chart-skill-loaded' })).toBeVisible()
 } finally {
  rmSync(cwd, { recursive: true, force: true })
 }
})


test('Native delegates only one level', async ({ page }) => {
 const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-depth-')))
 try {
  const response = await page.request.post('/api/sessions', { headers, data: { agent: 'native', cwd, model: 'openrouter:test/native' } })
  expect(response.ok()).toBe(true)
  const parent = await response.json()
  await page.goto(`/s/${parent.id}?token=${token}`)
  await page.getByLabel('Message').fill('native delegation boundary')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('native: native delegation boundary', { exact: true })).toBeVisible()
  const sessions = await (await page.request.get('/api/sessions', { headers })).json()
  const children = sessions.filter((s: { parentId?: string }) => s.parentId === parent.id)
  expect(children).toHaveLength(1)
  expect(sessions.filter((s: { parentId?: string }) => s.parentId === children[0].id)).toHaveLength(0)
  await page.goto(`/s/${children[0].id}?token=${token}`)
  await expect(page.getByText('executor boundary verified', { exact: true })).toBeVisible()
 } finally {
  rmSync(cwd, { recursive: true, force: true })
 }
})
