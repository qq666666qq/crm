import {ClipboardList} from 'lucide-react';

export function Empty({text='暂无记录'}:{text?:string}) {return <div className="empty"><div className="empty-icon"><ClipboardList size={20}/></div><span>{text}</span></div>;}
