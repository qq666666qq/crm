import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRunCoordinator} from './run-coordinator.mjs';

test('关闭等待已接收的对话和轨迹，并拒绝新的工作',async()=>{
 let release,started;const begun=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;}),events=[];
 const runtime={conversationId:1,chat:async(_text,_run,_id,onStart)=>{await onStart({existing:false,conversationId:1});events.push('chat-start');started();await gate;return {answer:'回答'};},traceSave:async()=>events.push('trace-save'),close:async()=>events.push('runtime-close')};
 const trace={start:async()=>{events.push('trace-start');return 'run';},finish:async()=>events.push('trace-finish')};
 const runs=createRunCoordinator({getRuntime:()=>runtime,getTrace:()=>trace,ready:Promise.resolve(),send:()=>{}});
 assert.equal(runs.accept(()=>runs.chat('问题')),true);await begun;
 const close=runs.close();assert.equal(runs.accept(()=>{}),false);await Promise.resolve();assert.equal(events.includes('runtime-close'),false);
 release();await close;assert.deepEqual(events,['trace-start','chat-start','trace-finish','trace-save','runtime-close']);
});

test('聊天运行状态只允许一次真实重叠的运行',async()=>{
 let release,started;const begun=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const runtime={conversationId:1,chat:async(_text,_run,_id,onStart)=>{await onStart({existing:false,conversationId:1});started();await gate;return {answer:'回答'};},traceSave:async()=>{},close:async()=>{}};
 const runs=createRunCoordinator({getRuntime:()=>runtime,getTrace:()=>({start:async()=> 'run',finish:async()=>{}}),ready:Promise.resolve(),send:()=>{}});
 const first=runs.chat('第一条');await begun;await assert.rejects(runs.chat('第二条'),/BUSY/);release();await first;await runs.close();
});


test('同一请求重连共享进行中的运行，不同内容不能复用标识',async()=>{
 let release,started,count=0;const begun=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const runtime={conversationId:1,chat:async(_text,_run,_id,onStart)=>{count++;await onStart({existing:false,conversationId:1});started();await gate;return {answer:'回答'};},traceSave:async()=>{},close:async()=>{}};
 const runs=createRunCoordinator({getRuntime:()=>runtime,getTrace:()=>({start:async()=> 'run',finish:async()=>{}}),ready:Promise.resolve(),send:()=>{}});
 const id='12345678-1234-1234-1234-123456789abc',first=runs.chat('问题',id);await begun;const second=runs.chat('问题',id);await assert.rejects(runs.chat('不同问题',id),/CHAT_REQUEST_CONFLICT/);release();assert.deepEqual(await first,await second);assert.equal(count,1);await runs.close();
});
