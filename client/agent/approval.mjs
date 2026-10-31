import {createHash,randomUUID} from 'node:crypto';
function canonical(value){if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;throw new Error('Unsupported approval content');}
function digest(type,content){return createHash('sha256').update(canonical({type,content})).digest('hex');}
export class ApprovalGate{
 #requests=new Map();
 propose(type,content){if(!['send_email','create_lead','convert_lead'].includes(type))throw new Error('Unsupported approval action');const id=randomUUID();this.#requests.set(id,{hash:digest(type,content),status:'pending'});return {id,status:'pending'};}
 approve(id){const r=this.#requests.get(id);if(!r||r.status!=='pending')throw new Error('Invalid approval');r.status='approved';}
 reject(id){const r=this.#requests.get(id);if(!r||r.status!=='pending')throw new Error('Invalid approval');r.status='rejected';}
 consume(id,type,content){const r=this.#requests.get(id);if(!r||r.status!=='approved'||r.hash!==digest(type,content))throw new Error('Approval missing or content changed');r.status='consumed';}
}
