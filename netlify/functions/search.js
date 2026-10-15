const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const reply = (statusCode, body) => ({statusCode, headers:{'content-type':'application/json','cache-control':'no-store'}, body:JSON.stringify(body)});
const amount = x => x && Number.isFinite(Number(x.value)) ? Number(x.value) : null;
const normalizedCondition = s => (s || '').toLowerCase();
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return reply(405,{error:'Method not allowed'});
  const p = event.queryStringParameters || {};
  const q = String(p.q||'').trim().slice(0,100);
  const budget = Number(p.budget);
  const maxShipping = Number(p.shipping);
  const condition = String(p.condition||'any').toLowerCase();
  if (!q || !Number.isFinite(budget) || budget<=0 || !Number.isFinite(maxShipping) || maxShipping<0 || !['any','used','new'].includes(condition)) return reply(400,{error:'Enter a keyword, positive budget, and valid shipping limit.'});
  const id = process.env.EBAY_CLIENT_ID, secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) return reply(500,{error:'eBay credentials are not configured in Netlify environment variables.'});
  try {
    const basic = Buffer.from(`${id}:${secret}`).toString('base64');
    const tokenResp = await fetch(TOKEN_URL,{method:'POST',headers:{Authorization:`Basic ${basic}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',scope:'https://api.ebay.com/oauth/api_scope'})});
    if (!tokenResp.ok) return reply(502,{error:`eBay authentication failed (${tokenResp.status}). Check the matching Production App ID and Cert ID.`,stage:'oauth'});
    const {access_token} = await tokenResp.json();
    const url = new URL(SEARCH_URL);
    url.searchParams.set('q',q);
    url.searchParams.set('limit','100');
    url.searchParams.set('filter','buyingOptions:{FIXED_PRICE},itemLocationCountry:US');
    const searchResp = await fetch(url,{headers:{Authorization:`Bearer ${access_token}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_US','Accept':'application/json'}});
    if (!searchResp.ok) return reply(502,{error:`eBay Browse API request failed (${searchResp.status}). API access may require eBay approval.`,stage:'browse'});
    const data = await searchResp.json();
    const listings = (data.itemSummaries||[]).map(x=>{
      const price = amount(x.price);
      const shippingOptions = x.shippingOptions||[];
      const shippingCosts = shippingOptions.map(y=>amount(y.shippingCost)).filter(v=>v!==null);
      const shipping = shippingCosts.length ? Math.min(...shippingCosts) : null;
      const cond = normalizedCondition(x.condition);
      return {id:x.itemId,title:x.title||'Untitled listing',image:x.image?.imageUrl||'',url:x.itemWebUrl||'',price,shipping,condition:x.condition||'Not specified',cond, currency:x.price?.currency||'USD'};
    }).filter(x=>x.price!==null && x.shipping!==null && x.currency==='USD' && x.url && x.price+x.shipping<=budget && x.shipping<=maxShipping && (condition==='any'||(condition==='used' ? (x.cond.includes('used')||x.cond.includes('pre-owned')||x.cond.includes('refurbished')) : x.cond.includes('new'))));
    // Compare against the median of returned comparable listings, not a claimed market-wide benchmark.
    const prices = listings.map(x=>x.price).sort((a,b)=>a-b);
    const median = prices.length ? (prices[Math.floor((prices.length-1)/2)]+prices[Math.floor(prices.length/2)])/2 : 0;
    const scored = listings.map(x=>{
      const total=x.price+x.shipping;
      const priceScore=Math.max(0,100*(1-total/budget));
      const conditionScore=x.cond.includes('new')?100:x.cond.includes('refurbished')?80:65;
      const shippingScore=maxShipping===0?(x.shipping===0?100:0):Math.max(0,100*(1-x.shipping/maxShipping));
      const score=Math.round((0.6*priceScore+0.25*conditionScore+0.15*shippingScore)*10)/10;
      return {...x,total,score,savingsPercent:median>0?Math.round((median-x.price)/median*1000)/10:null};
    }).sort((a,b)=>b.score-a.score).slice(0,5);
    return reply(200,{results:scored,eligibleCount:listings.length,medianPrice:median,notes:'Listings without explicit shipping costs are excluded. Savings are relative to the median of eligible returned listings. Scores are illustrative.'});
  } catch(e){return reply(502,{error:'Unable to connect to eBay right now. Please try again.'});}
};
