import 'dotenv/config';
import OpenAI from 'openai';
import { getAddress } from 'ethers';

export const KILN_BASE_URL = 'https://api.bricksum.com/v1';
export const MODEL = 'qwen3-32b';
export const CATEGORY = Object.freeze({ SPORT: 0, CONCERT: 1 });

const tool = {
  type: 'function',
  function: {
    name: 'evaluate_ticket_listing',
    description: 'Approve or reject one ticket listing under BOTH the category KRW cap and 150% original-price cap.',
    parameters: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['APPROVE', 'REJECT'] },
        reason: { type: 'string' }
      },
      required: ['decision', 'reason'],
      additionalProperties: false
    }
  }
};

const walletNames = new Map();
const bankNames = new Map();
const verifiedWallets = new Set();
const fulfilledBookings = new Set();
const normalizeName = name => String(name).normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko-KR');

// Mock identity-provider and bank fixtures. The caller must NOT use this as real KYC.
export function seedKycMock({ walletAddress, walletName, bankAccountId, bankName }) {
  walletNames.set(getAddress(walletAddress), String(walletName));
  bankNames.set(String(bankAccountId), String(bankName));
}

export async function verifyKycMock(walletAddress, bankAccountId) {
  const wallet = getAddress(walletAddress);
  const walletName = walletNames.get(wallet);
  const bankName = bankNames.get(String(bankAccountId));
  const approved = Boolean(walletName && bankName && normalizeName(walletName) === normalizeName(bankName));
  if (approved) verifiedWallets.add(wallet);
  console.log(`[KYC MOCK] wallet=${wallet} bank=${bankAccountId} ${approved ? 'APPROVE' : 'REJECT'}`);
  return approved;
}

// Mock booking webhook: authorized organizer signer mints immediately after an accepted booking.
export async function externalBookingSuccessMock({ provider, bookingRef, walletAddress, category, facePriceKRW, eventId, ticket, organizerSigner }) {
  if (!['INTERPARK', 'MELON_TICKET'].includes(provider)) throw new Error('UNSUPPORTED_BOOKING_PROVIDER');
  const key = `${provider}:${bookingRef}`;
  if (!bookingRef || fulfilledBookings.has(key)) throw new Error('DUPLICATE_OR_INVALID_BOOKING');
  const wallet = getAddress(walletAddress);
  if (!verifiedWallets.has(wallet)) throw new Error('KYC_REQUIRED');
  fulfilledBookings.add(key); // Reserve before awaiting a transaction to prevent concurrent duplicate mints.
  try {
    const tx = await ticket.connect(organizerSigner).mint(wallet, category, facePriceKRW, eventId);
    const receipt = await tx.wait();
    const minted = receipt.logs.map(log => { try { return ticket.interface.parseLog(log); } catch { return null; } })
      .find(log => log?.name === 'Transfer' && log.args.from === '0x0000000000000000000000000000000000000000');
    if (!minted) throw new Error('MINT_EVENT_MISSING');
    const tokenId = minted.args.tokenId;
    console.log(`[BOOKING MOCK] ${provider} ${bookingRef} -> NFT #${tokenId} wallet=${wallet} tx=${receipt.hash}`);
    return { tokenId, txHash: receipt.hash };
  } catch (error) {
    fulfilledBookings.delete(key);
    throw error;
  }
}

export function hardPriceGuard({ category, facePriceKRW, askingPriceKRW }) {
  const face = Number(facePriceKRW), ask = Number(askingPriceKRW);
  if (![CATEGORY.SPORT, CATEGORY.CONCERT].includes(Number(category)) || !Number.isSafeInteger(face) || !Number.isSafeInteger(ask) || face <= 0 || ask <= 0) {
    return { ok: false, reason: 'INVALID_TICKET_PRICE_OR_CATEGORY' };
  }
  const cap = Number(category) === CATEGORY.SPORT ? 500_000 : 1_000_000;
  if (ask > cap) return { ok: false, reason: `ABSOLUTE_CAP: ${ask} KRW > ${cap} KRW` };
  // Integer-safe equivalent of ask <= floor(face * 1.5).
  if (BigInt(ask) > BigInt(face) + BigInt(face) / 2n) return { ok: false, reason: `MARKUP_CAP: ${ask} KRW > 150% of ${face} KRW` };
  return { ok: true, reason: 'Both price ceilings satisfied' };
}

function simulateToolCall(listing) {
  const guard = hardPriceGuard(listing);
  return {
    choices: [{ message: { tool_calls: [{ function: {
      name: 'evaluate_ticket_listing',
      arguments: JSON.stringify({ decision: guard.ok ? 'APPROVE' : 'REJECT', reason: guard.reason })
    } }] } }],
    usage: { total_tokens: 0 }
  };
}

// LLM output is advisory. Only APPROVE + deterministic checks produce an EIP-712 authorization.
export async function evaluateTicketListing(listing, { approvalWallet, escrowAddress, chainId, demo = false, flow = 'LISTING' }) {
  let response;
  let modelDecision = 'REJECT';
  let modelReason = 'Missing or invalid function call';
 try {
    if (demo) {
      response = simulateToolCall(listing);
    } else {
      if (!process.env.KILN_API_KEY) throw new Error('KILN_API_KEY_MISSING');
      const client = new OpenAI({ apiKey: process.env.KILN_API_KEY, baseURL: KILN_BASE_URL, timeout: 30_000, maxRetries: 0 });
      response = await client.chat.completions.create({
        model: MODEL,
        temperature: 0,
        max_tokens: 1024,
        messages: [
          // 프롬프트 수정: tools를 쓰지 않고 JSON 텍스트만 출력하도록 강력하게 지시
          { role: 'system', content: 'You are a ticket listing reviewer. A sports listing is at most 500000 KRW; a concert listing is at most 1000000 KRW. Every listing is at most 150% of immutable original face price. You MUST output ONLY valid JSON containing exactly two keys: "decision" ("APPROVE" or "REJECT") and "reason". Do not include any other text, explanation, or markdown formatting.' },
          { role: 'user', content: JSON.stringify({ category: Number(listing.category) === 0 ? 'SPORT' : 'CONCERT', facePriceKRW: listing.facePriceKRW, askingPriceKRW: listing.askingPriceKRW, tokenId: String(listing.tokenId) }) }
        ]
        // 기존에 있던 tools와 tool_choice 옵션은 삭제합니다.
      });
    }

    const msg = response.choices?.[0]?.message;
    
    // AI가 응답을 content에 넣었는지, 레거시 환경 변수에 넣었는지 모두 추적
    let rawArgs = msg?.content || msg?.function_call?.arguments || msg?.tool_calls?.[0]?.function?.arguments || "";
    console.log("AI 원본 응답:", rawArgs);

    // AI가 ```json { ... } ``` 형태로 마크다운을 붙여서 보냈을 경우를 대비해 텍스트 정제
    rawArgs = rawArgs.replace(/```json/gi, '').replace(/```/g, '').trim();

    if (!rawArgs) throw new Error('EMPTY_RESPONSE_FROM_MODEL');

    const args = JSON.parse(rawArgs); 
    if (!['APPROVE', 'REJECT'].includes(args.decision) || typeof args.reason !== 'string') {
        throw new Error('INVALID_TOOL_ARGUMENTS');
    }
    
    modelDecision = args.decision;
    modelReason = args.reason;
  // 여기서부터는 기존 catch (err) { 블록이 이어집니다.
  } catch (err) {
    modelDecision = 'REJECT';
    const summary = err.status ? `HTTP_${err.status}${err.code ? `_${err.code}` : ''}` : (err.code || err.message);
    modelReason = `FAIL_CLOSED: ${String(summary).slice(0, 200)}`;
  }
  const tokens = response?.usage?.total_tokens ?? null;
  console.log(`[AI][${flow}] model=${MODEL} mode=${demo ? 'MOCK (not a Kiln call)' : 'KILN'} usage.total_tokens=${tokens ?? 'unavailable'} modelDecision=${modelDecision}`);
  const guard = hardPriceGuard(listing);
  const approved = modelDecision === 'APPROVE' && guard.ok;
  const reason = !guard.ok ? guard.reason : modelReason;
  if (!approved) {
    console.log(`[STOP][${flow}] REJECT reason=${reason}; no listing authorization signed`);
    return { decision: 'REJECT', modelDecision, reason, totalTokens: tokens, signature: null };
  }
  if (!approvalWallet || !escrowAddress || !chainId) throw new Error('SIGNER_CONFIG_MISSING');
  const domain = { name: 'TicketGuard', version: '1', chainId: BigInt(chainId), verifyingContract: getAddress(escrowAddress) };
  const types = { ListingApproval: [
    { name: 'ticket', type: 'address' }, { name: 'tokenId', type: 'uint256' },
    { name: 'seller', type: 'address' }, { name: 'category', type: 'uint8' },
    { name: 'facePriceKRW', type: 'uint256' }, { name: 'askingPriceKRW', type: 'uint256' },
    { name: 'eventId', type: 'bytes32' }, { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }
  ] };
  const value = {
    ticket: getAddress(listing.ticketAddress), tokenId: BigInt(listing.tokenId), seller: getAddress(listing.seller),
    category: Number(listing.category), facePriceKRW: BigInt(listing.facePriceKRW),
    askingPriceKRW: BigInt(listing.askingPriceKRW), eventId: listing.eventId,
    deadline: BigInt(listing.deadline), nonce: BigInt(listing.nonce)
  };
  const signature = await approvalWallet.signTypedData(domain, types, value);
  console.log(`[AI][${flow}] APPROVE; signed bounded listing approval nonce=${listing.nonce}`);
  return { decision: 'APPROVE', modelDecision, reason, totalTokens: tokens, signature };
}
