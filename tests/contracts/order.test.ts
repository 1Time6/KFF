import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {orderPreviewInput,productVersionInput,orderConfirmInput,displayMinor} from '../../packages/contracts/src/order';
it('requires integer price strings, explicit precision and bounded unique order lines',()=>{
  const product={request_id:randomUUID(),sku:'OWNED-1',name:'Synthetic service',currency:'USD',minor_unit_exponent:2,precision_source:'Synthetic fixture currency definition',unit_amount_minor:'1250',delivery_scope:'One synthetic report',terms:'No real sale; local verification only'};
  expect(productVersionInput.parse(product).unit_amount_minor).toBe('1250');
  for(const unit_amount_minor of [1250,1.2,'12.50','-1','1e6','01'])expect(productVersionInput.safeParse({...product,unit_amount_minor}).success).toBe(false);
  const item={product_id:randomUUID(),quantity:1},input={request_id:randomUUID(),customer_id:randomUUID(),conversation_id:null,items:[item]};expect(orderPreviewInput.parse(input)).toEqual(input);
  for(const items of [[item,item],[{...item,quantity:0}],[{...item,quantity:1.5}],[{...item,quantity:1001}],[]])expect(orderPreviewInput.safeParse({...input,items}).success).toBe(false);
  expect(orderPreviewInput.safeParse({...input,total_minor:'0',paid:true}).success).toBe(false);
});
it('requires exact confirmation and formats zero, large values and all supported decimal positions without floats',()=>{
  const input={request_id:randomUUID(),preview_id:randomUUID(),preview_hash:'a'.repeat(64),confirmed_total_minor:'2500',currency:'USD',confirmation:'CREATE_THIS_ORDER'};expect(orderConfirmInput.parse(input).confirmed_total_minor).toBe('2500');
  for(const changes of [{payment_state:'PAID'},{confirmed_total_minor:2500},{confirmed_total_minor:'1e10'},{confirmation:true}])expect(orderConfirmInput.safeParse({...input,...changes}).success).toBe(false);
  expect(displayMinor('0',2)).toBe('0.00');expect(displayMinor('12',0)).toBe('12');expect(displayMinor('1',6)).toBe('0.000001');expect(displayMinor('999999999999999999',2)).toBe('9999999999999999.99');expect(displayMinor('12.3',2)).toBe('—');
});
