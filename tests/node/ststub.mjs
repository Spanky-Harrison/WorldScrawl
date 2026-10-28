// A bare-bones SillyTavern stand-in so extension/index.js can be imported in node (prompt snapshot tests).
const h = new Proxy(function(){}, { get:(t,k)=> k===Symbol.toPrimitive? ()=>'' : k==='then'?undefined: h, apply:()=>h, construct:()=>h });
const base = {extensionSettings:{},chat:[],chatMetadata:{},name1:'You', name2:'Bot', eventTypes:{}, eventSource:{on(){}}};
globalThis.SillyTavern={getContext:()=>new Proxy(base,{get:(t,k)=> k in t ? t[k] : h})};
globalThis.jQuery=globalThis.$=h; globalThis.document=h; globalThis.toastr=h; globalThis.BroadcastChannel=h;
globalThis.window=globalThis; globalThis.fetch=async()=>({ok:false,json:async()=>({})});
