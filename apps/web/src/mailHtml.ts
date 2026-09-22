import DOMPurify from 'dompurify';

/** Formatting only. Mail markup must never enter the app's own document. */
export function formattedMailDocument(html:string):string {
 if(typeof html!=='string'||new TextEncoder().encode(html).length>16000||!DOMPurify.isSupported)throw new Error('Formatted preview unavailable');
 const clean=DOMPurify.sanitize(html,{
  ALLOWED_TAGS:['p','br','div','span','strong','b','em','i','u','s','blockquote','pre','code','ul','ol','li','dl','dt','dd','h1','h2','h3','h4','h5','h6','table','thead','tbody','tfoot','tr','th','td','caption','hr','sub','sup'],
  ALLOWED_ATTR:[],ALLOW_ARIA_ATTR:false,ALLOW_DATA_ATTR:false,
  FORBID_TAGS:['style','script','template','svg','math','form','input','button','select','textarea','iframe','object','embed','img','video','audio','source','link','meta','base'],
  SANITIZE_DOM:true,SANITIZE_NAMED_PROPS:true,RETURN_TRUSTED_TYPE:false,
 });
 return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><meta name="referrer" content="no-referrer"><style>body{font:16px/1.6 system-ui,sans-serif;margin:16px;color:#181818;background:#fff;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #bbb;padding:6px}pre{white-space:pre-wrap}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:16px}</style></head><body>'+clean+'</body></html>';
}
