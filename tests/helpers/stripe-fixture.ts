import {randomBytes,randomUUID} from 'node:crypto';
import Stripe from 'stripe';
import {AppError,digest} from '../../packages/core/src/index';
import {STRIPE_API_VERSION,type StripeGateway,type StripeGatewayFactory,type StripeSession,type StripeIntent} from '../../packages/core/src/stripe-gateway';
export class StripeFixture implements StripeGateway {
  isSynthetic=true;accountId='acct_'+randomUUID().replaceAll('-','');currencies=['usd','jpy','isk','ugx'];loseResponse=0;unavailable=false;wrongAccount=false;
  sessions=new Map<string,StripeSession>();intents=new Map<string,StripeIntent>();requests=new Map<string,{hash:string;id:string}>();calls:{key:string;input:Stripe.Checkout.SessionCreateParams}[]=[];
  factory:StripeGatewayFactory=async()=>this;
  async identity(){if(this.unavailable)throw new AppError('STRIPE_UNAVAILABLE','Synthetic unavailable',503);return {id:this.wrongAccount?'acct_other':this.accountId,currencies:this.currencies};}
  async createSession(input:Stripe.Checkout.SessionCreateParams,key:string){
    this.calls.push({key,input:structuredClone(input)});const prior=this.requests.get(key);if(prior){if(prior.hash!==digest(input))throw new AppError('STRIPE_REQUEST_REJECTED','Synthetic idempotency mismatch');return structuredClone(this.sessions.get(prior.id)!);}
    const id='cs_test_'+randomUUID().replaceAll('-','');
    const session:StripeSession={id,object:'checkout.session',mode:'payment',livemode:false,amount_total:input.line_items!.reduce((sum,line)=>sum+Number(line.price_data!.unit_amount)*Number(line.quantity),0),currency:input.line_items![0].price_data!.currency,client_reference_id:input.client_reference_id!,metadata:input.metadata as StripeSession['metadata'],status:'open',payment_status:'unpaid',payment_intent:null,url:'https://checkout.stripe.com/c/pay/'+id};
    this.requests.set(key,{hash:digest(input),id});this.sessions.set(id,session);if(this.loseResponse>0){this.loseResponse--;throw new AppError('STRIPE_UNAVAILABLE','Synthetic response lost',503);}return structuredClone(session);
  }
  async retrieveSession(id:string){if(this.unavailable)throw new AppError('STRIPE_UNAVAILABLE','Synthetic unavailable',503);const found=this.sessions.get(id);if(!found)throw new AppError('STRIPE_OBJECT_MISMATCH','Synthetic unknown session',409);return structuredClone(found);}
  async retrieveIntent(id:string){if(this.unavailable)throw new AppError('STRIPE_UNAVAILABLE','Synthetic unavailable',503);const found=this.intents.get(id);if(!found)throw new AppError('STRIPE_OBJECT_MISMATCH','Synthetic unknown intent',409);return structuredClone(found);}
  pay(id:string,pending=false){const session=this.sessions.get(id)!;const pi=typeof session.payment_intent==='string'?session.payment_intent:'pi_'+randomUUID().replaceAll('-','');session.status='complete';session.payment_status=pending?'unpaid':'paid';session.payment_intent=pi;session.url=null;this.intents.set(pi,{id:pi,object:'payment_intent',livemode:false,amount:session.amount_total!,amount_received:pending?0:session.amount_total!,currency:session.currency!,status:pending?'processing':'succeeded',metadata:session.metadata!});return session;}
  expire(id:string){const session=this.sessions.get(id)!;session.status='expired';session.url=null;return session;}
}
export function syntheticStripeCredentials(ref:string,binding:{organization_id:string;brand_id:string;stripe_account_id:string}){const apiKey='rk_test_'+randomBytes(24).toString('hex'),secret='whsec_'+randomBytes(24).toString('hex');process.env[ref+'_API_KEY']=apiKey;process.env[ref+'_WEBHOOK_SECRETS']=secret;process.env[ref+'_ORGANIZATION_ID']=binding.organization_id;process.env[ref+'_BRAND_ID']=binding.brand_id;process.env[ref+'_ACCOUNT_ID']=binding.stripe_account_id;return {apiKey,secret};}
export function signedStripeEvent(session:StripeSession,secret:string,type='checkout.session.completed',changes:Record<string,unknown>={}){
  const payload={id:'evt_'+randomUUID().replaceAll('-',''),object:'event',type,created:Math.floor(Date.now()/1000),api_version:STRIPE_API_VERSION,livemode:false,data:{object:session},...changes};const raw=Buffer.from(JSON.stringify(payload));const signature=Stripe.webhooks.generateTestHeaderString({payload:raw.toString(),secret});return {payload,raw,signature};
}
