import { expect, it, vi } from 'vitest'
import { runConnectorWorker } from '../src/worker'
it('uses one idle poller with bounded backoff and stops on abort',async()=>{
 const control=new AbortController(),delays:number[]=[]
 const poll=vi.fn(async()=>null),execute=vi.fn(),complete=vi.fn()
 await runConnectorWorker({signal:control.signal,poll,execute,complete,health:async()=>{},wait:async ms=>{delays.push(ms);if(delays.length===6)control.abort()}})
 expect(delays).toEqual([1000,2000,4000,8000,8000,8000]);expect(poll).toHaveBeenCalledTimes(6);expect(execute).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled()
})
it('never retries a consumed lease after a failed completion',async()=>{
 const control=new AbortController(),execute=vi.fn(async()=>({data:{},error:null,truncated:false,observedAt:new Date().toISOString()})),complete=vi.fn(async()=>{throw new Error('lost response')})
 const poll=vi.fn().mockResolvedValueOnce({id:'lease',leaseId:'token',expiresAt:new Date(Date.now()+30000).toISOString(),command:{mode:'read',query:{operation:'identity'}}}).mockResolvedValue(null)
 await runConnectorWorker({signal:control.signal,poll,execute,complete,health:async()=>{},wait:async()=>{control.abort()}})
 expect(execute).toHaveBeenCalledTimes(1);expect(complete).toHaveBeenCalledTimes(1)
})
it('reports a lease without time to finish as unexecuted',async()=>{
 const control=new AbortController(),execute=vi.fn(),complete=vi.fn(async()=>{})
 const command={mode:'write' as const,mutation:{operation:'delete' as const,ref:{resource:'pods' as const,namespace:'shop',name:'frontend-1'},uid:'pod-a',resourceVersion:'7'},dryRun:false}
 const poll=vi.fn().mockResolvedValueOnce({id:'lease',leaseId:'token',expiresAt:new Date(Date.now()+5000).toISOString(),command}).mockResolvedValue(null)
 await runConnectorWorker({signal:control.signal,poll,execute,complete,health:async()=>{},wait:async()=>{control.abort()}})
 expect(execute).not.toHaveBeenCalled()
 expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:'lease'}),expect.objectContaining({data:null,error:'unavailable'}))
})
