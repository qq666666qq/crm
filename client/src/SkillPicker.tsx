import {useEffect,useRef,useState} from 'react';

export function SkillPicker({busy,revision}:{busy:boolean;revision:number}){
 const [skills,setSkills]=useState<{name:string}[]>([]),[selected,setSelected]=useState<string[]>([]),[working,setWorking]=useState(false),[error,setError]=useState('');const sequence=useRef(0);
 useEffect(()=>{let active=true;const load=async()=>{const current=++sequence.current;try{const result=await window.crm.agent('memory-status');if(active&&sequence.current===current){setSkills(result.skills);setSelected(result.selectedSkills);}}catch{if(active&&sequence.current===current)setError('无法读取技能列表。');}};void load();return()=>{active=false;sequence.current++;};},[revision]);
 async function change(name:string,checked:boolean){const next=checked?[...selected,name]:selected.filter(item=>item!==name);try{setWorking(true);setError('');const result=await window.crm.agent('memory-skills',next);setSelected(result.selected);}catch{setError('技能设置未保存，请检查权限。');}finally{setWorking(false);}}
 return <div className="agent-skill-picker"><h3>本次对话使用的技能</h3><p className="agent-control-note">最多选择 5 个已发布的技能。</p>{skills.length?skills.map(skill=><label className="agent-skill-option" key={skill.name}><input type="checkbox" checked={selected.includes(skill.name)} disabled={busy||working||(!selected.includes(skill.name)&&selected.length>=5)} onChange={event=>void change(skill.name,event.target.checked)}/><span>{skill.name}</span></label>):<p className="agent-control-note">暂无已发布的技能。</p>}{error&&<p className="notice warning" role="alert">{error}</p>}</div>;
}
