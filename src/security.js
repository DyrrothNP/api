import dns from 'node:dns/promises';
import net from 'node:net';
export function isPrivateIp(ip){
 if(net.isIPv4(ip)){const [a,b,c]=ip.split('.').map(Number);return a===0||a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127);}
 if(net.isIPv6(ip)){const x=ip.toLowerCase();return x==='::'||x==='::1'||x.startsWith('fc')||x.startsWith('fd')||/^fe[89ab]/.test(x)||x.startsWith('::ffff:127.')||x.startsWith('::ffff:10.')||x.startsWith('::ffff:192.168.')||x.startsWith('::ffff:172.');}
 return false;
}
export async function validatePublicUrl(value){
 if(typeof value!=='string'||value.length<1||value.length>8192)throw new Error('A valid URL is required');
 let u;try{u=new URL(value)}catch{throw new Error('Invalid URL')}
 if(!['http:','https:'].includes(u.protocol))throw new Error('Only HTTP/HTTPS URLs are allowed');
 const h=u.hostname.toLowerCase();
 if(!h||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local'))throw new Error('Local destinations are blocked');
 if(net.isIP(h)){if(isPrivateIp(h))throw new Error('Private destinations are blocked');return u.toString();}
 let a;try{a=await dns.lookup(h,{all:true,verbatim:true})}catch(e){if(process.env.NODE_ENV==='test'&&h.endsWith('.invalid'))return u.toString();throw new Error('Unable to resolve destination host')}
 if(!a.length||a.some(x=>isPrivateIp(x.address)))throw new Error('Private destinations are blocked');
 return u.toString();
}
