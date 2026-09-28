import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import solc from 'solc';
import ganache from 'ganache';
import { AbiCoder, BrowserProvider, ContractFactory, MaxUint256, Wallet, id } from 'ethers';
import { CATEGORY, seedKycMock, verifyKycMock, externalBookingSuccessMock, evaluateTicketListing } from './agent.js';

// npm test uses --demo: named-tool response is simulated and token count is 0.
// npm run test:kiln uses the actual Kiln endpoint and requires KILN_API_KEY.
const demo = !process.argv.includes('--kiln');
const STATE = { LISTED: 1n, FUNDED: 2n, SETTLED: 3n, REFUNDED: 4n };
const results = [];
let nonce = 1;

function compile(source) {
  const input = { language: 'Solidity', sources: { 'TicketEscrow.sol': { content: source } }, settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
  } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  for (const issue of output.errors || []) if (issue.severity === 'error') throw new Error(issue.formattedMessage);
  return output.contracts['TicketEscrow.sol'];
}
async function deploy(compiled, name, signer, args = []) {
  const artifact = compiled[name];
  const contract = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}
function eventFrom(contract, receipt, name) {
  return receipt.logs.map(log => { try { return contract.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === name);
}
function revertReason(error) {
  const rpc = error.info?.error;
  const detail = rpc?.data;
  if (typeof detail?.reason === 'string' && detail.reason) return detail.reason;
  const encoded = typeof detail === 'string' ? detail : detail?.result || detail?.data || error.data;
  if (typeof encoded === 'string' && encoded.startsWith('0x08c379a0')) {
    try { return AbiCoder.defaultAbiCoder().decode(['string'], `0x${encoded.slice(10)}`)[0]; } catch { /* use message below */ }
  }
  if (typeof encoded === 'string' && encoded.startsWith('0x4e487b71')) {
    try { return `PANIC code ${AbiCoder.defaultAbiCoder().decode(['uint256'], `0x${encoded.slice(10)}`)[0]}`; } catch { /* use message below */ }
  }
  return rpc?.message || error.reason || error.shortMessage || error.message;
}

async function main() {
  console.log(`TicketGuard prototype | chain=Ganache local devnet | AI=${demo ? 'MOCK named function call (no Kiln request)' : 'REAL Kiln qwen3-32b'}`);
  if (!demo && !process.env.KILN_API_KEY) throw new Error('KILN_API_KEY is required for --kiln; use npm test for a clearly labeled mock run.');
  const source = await readFile(new URL('./TicketEscrow.sol', import.meta.url), 'utf8');
  const compiled = compile(source);
  const chain = ganache.provider({ chain: { chainId: 31337, hardfork: 'shanghai' }, wallet: { totalAccounts: 6, defaultBalance: 100 }, logging: { quiet: true } });
  const provider = new BrowserProvider(chain);
  const organizer = await provider.getSigner(0), seller = await provider.getSigner(1), buyer = await provider.getSigner(2), donor = await provider.getSigner(4);
  const sellerAddress = await seller.getAddress(), buyerAddress = await buyer.getAddress(), donorAddress = await donor.getAddress();
  const approverAddress = await (await provider.getSigner(3)).getAddress();
  const approverKey = chain.getInitialAccounts()[approverAddress.toLowerCase()].secretKey;
  const approvalWallet = new Wallet(approverKey); // Local throwaway test key, never logged.
  const chainId = (await provider.getNetwork()).chainId;

  const payment = await deploy(compiled, 'MockKRW', organizer);
  const ticket = await deploy(compiled, 'MockTicket', organizer);
  const escrow = await deploy(compiled, 'TicketEscrow', organizer, [await ticket.getAddress(), await payment.getAddress(), approverAddress, donorAddress]);
  const escrowAddress = await escrow.getAddress();
  await (await payment.connect(organizer).mint(buyerAddress, 3_000_000)).wait();
  await (await payment.connect(buyer).approve(escrowAddress, MaxUint256)).wait();
  seedKycMock({ walletAddress: sellerAddress, walletName: '김판매', bankAccountId: 'BANK-SELLER-001', bankName: '김판매' });
  assert.equal(await verifyKycMock(sellerAddress, 'BANK-SELLER-001'), true);
  console.log(`[DEVNET] TicketEscrow=${escrowAddress} MockKRW=${await payment.getAddress()} MockTicket=${await ticket.getAddress()}`);

  async function booking(category, facePriceKRW, eventId, ref) {
    await (await escrow.connect(organizer).registerEvent(eventId)).wait();
    return externalBookingSuccessMock({ provider: 'INTERPARK', bookingRef: ref, walletAddress: sellerAddress, category, facePriceKRW, eventId, ticket, organizerSigner: organizer });
  }
  async function review(tokenId, category, facePriceKRW, askingPriceKRW, eventId, flow) {
    const listing = {
      ticketAddress: await ticket.getAddress(), tokenId, seller: sellerAddress, category,
      facePriceKRW, askingPriceKRW, eventId,
      deadline: Math.floor(Date.now() / 1000) + 3600, nonce: nonce++
    };
    const decision = await evaluateTicketListing(listing, { approvalWallet, escrowAddress, chainId, demo, flow });
    return { listing, decision };
  }
  async function listApproved(tokenId, askingPriceKRW, reviewed) {
    assert.equal(reviewed.decision.decision, 'APPROVE', `AI must approve: ${reviewed.decision.reason}`);
    await (await ticket.connect(seller).approve(escrowAddress, tokenId)).wait();
    try {
      const recovered = await escrow.approvalSignerFor(tokenId, sellerAddress, askingPriceKRW, reviewed.listing.deadline, reviewed.listing.nonce, reviewed.decision.signature);
      console.log(`[SIGNATURE CHECK] recovered=${recovered} expected=${approvalWallet.address} match=${recovered.toLowerCase() === approvalWallet.address.toLowerCase()}`);
    } catch (error) {
      console.error(`[SIGNATURE CHECK] preview failed: ${revertReason(error)}`);
    }
    let receipt;
    try {
      const tx = await escrow.connect(seller).listTicket(tokenId, askingPriceKRW, reviewed.listing.deadline, reviewed.listing.nonce, reviewed.decision.signature);
      receipt = await tx.wait();
    } catch (error) {
      const metadata = await ticket.ticketData(tokenId);
      console.error('[LIST DIAGNOSTIC]', JSON.stringify({
        reason: revertReason(error),
        rawRevertData: error.info?.error?.data ?? error.data ?? null,
        chainTimestamp: Number((await provider.getBlock('latest')).timestamp),
        approvalDeadline: reviewed.listing.deadline,
        ticketFacePriceKRW: metadata.facePriceKRW.toString(),
        ticketCategory: metadata.category.toString(),
        ticketOwner: await ticket.ownerOf(tokenId),
        approvedSpender: await ticket.getApproved(tokenId),
        eventStatus: (await escrow.eventStatus(metadata.eventId)).toString(),
        approvalSignerMatches: (await escrow.approvalSigner()).toLowerCase() === approvalWallet.address.toLowerCase(),
        nonceUsed: await escrow.usedNonces(reviewed.listing.nonce)
      }));
      throw new Error(`listTicket reverted: ${revertReason(error)}`);
    }
    const listed = eventFrom(escrow, receipt, 'TicketListed');
    assert.ok(listed, 'TicketListed event missing');
    return { listingId: listed.args.listingId, txHash: receipt.hash };
  }

  // TEST 1: AI approval -> NFT and payment both escrowed -> 20/80 atomic settlement.
  console.log('\n=== Test 1: 정상 거래 + 20% 기부 정산 ===');
  const concertId = id('CONCERT-OK-001');
  const minted1 = await booking(CATEGORY.CONCERT, 500_000, concertId, 'BOOKING-001');
  const reviewed1 = await review(minted1.tokenId, CATEGORY.CONCERT, 500_000, 600_000, concertId, 'Test 1');
  const sale1 = await listApproved(minted1.tokenId, 600_000, reviewed1);
  assert.equal(await ticket.ownerOf(minted1.tokenId), escrowAddress, 'NFT must be escrowed on listing');
  const sellerBefore = await payment.balanceOf(sellerAddress), donorBefore = await payment.balanceOf(donorAddress), buyerBefore = await payment.balanceOf(buyerAddress);
  await (await escrow.connect(buyer).buyTicket(sale1.listingId)).wait();
  assert.equal((await escrow.listings(sale1.listingId)).state, STATE.FUNDED);
  assert.equal(await ticket.ownerOf(minted1.tokenId), escrowAddress, 'NFT stays in escrow until settlement');
  await (await escrow.connect(organizer).markEventCompleted(concertId)).wait();
  const settledReceipt = await (await escrow.connect(buyer).completeTransaction(sale1.listingId)).wait();
  const settled = eventFrom(escrow, settledReceipt, 'TransactionCompleted');
  assert.ok(settled);
  assert.equal(await ticket.ownerOf(minted1.tokenId), buyerAddress);
  assert.equal((await escrow.listings(sale1.listingId)).state, STATE.SETTLED);
  assert.equal((await payment.balanceOf(sellerAddress)) - sellerBefore, 480_000n);
  assert.equal((await payment.balanceOf(donorAddress)) - donorBefore, 120_000n);
  assert.equal(buyerBefore - (await payment.balanceOf(buyerAddress)), 600_000n);
  console.log(`[PASS][Test 1] sale=600000 mKRW | seller=480000 (80%) | donation=120000 (20%) | tx=${settledReceipt.hash} | AI tokens=${reviewed1.decision.totalTokens ?? 'unavailable'}`);
  results.push({ test: 1, result: 'PASS', aiTokens: reviewed1.decision.totalTokens, txHash: settledReceipt.hash });

  // TEST 2: Sports cap is not violated, but markup exceeds the original price by >50%.
  console.log('\n=== Test 2: 원가 1.5배 초과 -> AI STOP ===');
  const sportMarkupId = id('SPORT-MARKUP-002');
  const minted2 = await booking(CATEGORY.SPORT, 200_000, sportMarkupId, 'BOOKING-002');
  const reviewed2 = await review(minted2.tokenId, CATEGORY.SPORT, 200_000, 310_000, sportMarkupId, 'Test 2');
  assert.equal(reviewed2.decision.decision, 'REJECT');
  assert.equal(reviewed2.decision.signature, null);
  const nextIdBefore2 = await escrow.nextListingId();
  await assert.rejects(async () => {
    const tx = await escrow.connect(seller).listTicket(minted2.tokenId, 310_000, reviewed2.listing.deadline, reviewed2.listing.nonce, '0x');
    await tx.wait();
  }, error => {
    console.log(`[ONCHAIN STOP][Test 2] provider=${error.code} reason=${revertReason(error)}`);
    return error.code === 'CALL_EXCEPTION';
  });
  assert.equal(await escrow.nextListingId(), nextIdBefore2, 'rejected listing must not be created');
  assert.equal(await escrow.usedNonces(reviewed2.listing.nonce), false, 'rejected approval nonce must remain unused');
  assert.equal(await ticket.ownerOf(minted2.tokenId), sellerAddress);
  console.log(`[PASS][Test 2] STOP MARKUP_CAP: 310000 > 200000*1.5; NFT remains seller; no listing tx | AI tokens=${reviewed2.decision.totalTokens ?? 'unavailable'}`);
  results.push({ test: 2, result: 'STOP: MARKUP_CAP', aiTokens: reviewed2.decision.totalTokens, txHash: null });

  // TEST 3: Below the 150% markup limit but above sports' absolute KRW ceiling.
  console.log('\n=== Test 3: 스포츠 50만 원 초과 -> AI STOP ===');
  const sportAbsoluteId = id('SPORT-ABSOLUTE-003');
  const minted3 = await booking(CATEGORY.SPORT, 400_000, sportAbsoluteId, 'BOOKING-003');
  const reviewed3 = await review(minted3.tokenId, CATEGORY.SPORT, 400_000, 510_000, sportAbsoluteId, 'Test 3');
  assert.equal(reviewed3.decision.decision, 'REJECT');
  assert.equal(reviewed3.decision.signature, null);
  const nextIdBefore3 = await escrow.nextListingId();
  await assert.rejects(async () => {
    const tx = await escrow.connect(seller).listTicket(minted3.tokenId, 510_000, reviewed3.listing.deadline, reviewed3.listing.nonce, '0x');
    await tx.wait();
  }, error => {
    console.log(`[ONCHAIN STOP][Test 3] provider=${error.code} reason=${revertReason(error)}`);
    return error.code === 'CALL_EXCEPTION';
  });
  assert.equal(await escrow.nextListingId(), nextIdBefore3, 'rejected listing must not be created');
  assert.equal(await escrow.usedNonces(reviewed3.listing.nonce), false, 'rejected approval nonce must remain unused');
  assert.equal(await ticket.ownerOf(minted3.tokenId), sellerAddress);
  console.log(`[PASS][Test 3] STOP ABSOLUTE_CAP: 510000 > 500000; NFT remains seller; no listing tx | AI tokens=${reviewed3.decision.totalTokens ?? 'unavailable'}`);
  results.push({ test: 3, result: 'STOP: ABSOLUTE_CAP', aiTokens: reviewed3.decision.totalTokens, txHash: null });

  // TEST 4: buyer pre-pays; organizer cancels event; full refund + NFT back to seller.
  console.log('\n=== Test 4: 행사 취소 -> 구매자 100% 환불 ===');
  const rainId = id('CONCERT-RAIN-004');
  const minted4 = await booking(CATEGORY.CONCERT, 500_000, rainId, 'BOOKING-004');
  const reviewed4 = await review(minted4.tokenId, CATEGORY.CONCERT, 500_000, 600_000, rainId, 'Test 4');
  const sale4 = await listApproved(minted4.tokenId, 600_000, reviewed4);
  const buyerBeforeRefund = await payment.balanceOf(buyerAddress);
  await (await escrow.connect(buyer).buyTicket(sale4.listingId)).wait();
  assert.equal(buyerBeforeRefund - (await payment.balanceOf(buyerAddress)), 600_000n);
  await (await escrow.connect(organizer).cancelEvent(rainId)).wait();
  const refundReceipt = await (await escrow.connect(buyer).refundTransaction(sale4.listingId)).wait();
  const refunded = eventFrom(escrow, refundReceipt, 'TransactionRefunded');
  assert.ok(refunded);
  assert.equal(refunded.args.amountKRW, 600_000n);
  assert.equal(await payment.balanceOf(buyerAddress), buyerBeforeRefund);
  assert.equal(await ticket.ownerOf(minted4.tokenId), sellerAddress);
  assert.equal((await escrow.listings(sale4.listingId)).state, STATE.REFUNDED);
  console.log(`[PASS][Test 4] buyer refunded=600000/600000 mKRW; NFT returned to seller; tx=${refundReceipt.hash} | AI tokens=${reviewed4.decision.totalTokens ?? 'unavailable'}`);
  results.push({ test: 4, result: 'PASS: FULL REFUND', aiTokens: reviewed4.decision.totalTokens, txHash: refundReceipt.hash });

  console.log('\n=== FLOW-BY-FLOW TOKEN REPORT ===');
  for (const row of results) console.log(`Flow Test ${row.test}: ${row.result} | usage.total_tokens=${row.aiTokens ?? 'unavailable'} | txHash=${row.txHash ?? 'none'}`);
  console.log('NOTE: Ganache hashes are LOCAL DEVNET ONLY. In --demo mode, AI tokens=0 are simulated, not Kiln usage.');
  if (typeof chain.disconnect === 'function') await chain.disconnect();
}
main().catch(error => { console.error('[FAIL]', error); process.exitCode = 1; });
