'use client';
import {useRef} from 'react';
export function useRequestKey(){
  const pending=useRef<{payload:string;id:string}|null>(null);
  return {
    forPayload(value:unknown){const payload=JSON.stringify(value);if(pending.current?.payload!==payload)pending.current={payload,id:crypto.randomUUID()};return pending.current.id;},
    confirmed(){pending.current=null;},
  };
}
