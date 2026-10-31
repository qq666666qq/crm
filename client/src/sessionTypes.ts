export type Tenant = {id:string;name:string;role:string};
export type User = {user_id:string;name:string;email:string;role:string;permissions:{manage_members:boolean;manage_approvals:boolean}};
