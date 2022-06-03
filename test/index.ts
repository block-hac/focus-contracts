import { expect, use } from "chai";
import { ethers } from "hardhat";

import chaiAsPromised from "chai-as-promised";
import { BigNumber } from "ethers";

use(chaiAsPromised);

function areBigNumbersEqual(n1: BigNumber, n2: BigNumber) {
  console.log(parseFloat(formatEther(n1)).toFixed(3))
  console.log(parseFloat(formatEther(n2)).toFixed(3))
  return parseFloat(formatEther(n1)).toFixed(3) === parseFloat(formatEther(n2)).toFixed(3)
}

async function sleep(miliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(undefined)
    }, miliseconds)
  })
}

const { formatEther, parseEther, parseUnits } = ethers.utils;

describe("Token", async function () {

  async function initToken() {
    const FocusNFT1155 = await ethers.getContractFactory(
      "FocusNFT1155"
    );
    const token = await FocusNFT1155.deploy();

    await token.initialize("idk");

    return token
  }

  async function initAuction() {
    const signers = await ethers.getSigners()
    const FocusAuction = await ethers.getContractFactory(
      "FocusAuction"
    );

    const receiverOfFees = signers.slice(-1)[0]

    return { auction: (await FocusAuction.deploy(receiverOfFees.address, 4)), receiverOfFees };
  }

  async function init() {
    const [_acc1, acc2] = await ethers.getSigners()
    const token = await initToken()

    const tokenId = 1

    await token.connect(acc2).mint(acc2.address, tokenId, 2, 2, "whatfevs", []);

    expect(await token.balanceOf(acc2.address, tokenId)).equal(2);

    const { auction, receiverOfFees } = await initAuction()

    const tx = await token.connect(acc2).setApprovalForAll(auction.address, true);
    await tx.wait()

    return { auction, token, tokenId, receiverOfFees, tokenMinter: acc2 }
  }

  it("runs basic auction", async function() {
    const [acc1, acc2, acc3, acc4] = await ethers.getSigners()
    const { auction, token, tokenId, receiverOfFees } = await init()

    const endTime = 7

    const platformFee = 4
    await auction.connect(acc1).setPlatformFee(platformFee)

    await auction.connect(acc2).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, 0, 0)
    console.info("auction created")

    let auc = await auction.auctionsByToken(token.address, tokenId)

    expect(auc.seller).equal(acc2.address);
    expect(auc.initialPrice.eq(parseUnits("100", "finney")), "not equal1").equal(true)

    await auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("200", "finney") })
    console.info("first bid placed")

    auc = await auction.auctionsByToken(token.address, tokenId)
    expect(auc.highestBidder).equal(acc3.address)

    await auction.connect(acc4).placeBid(token.address, tokenId, { value: parseUnits("300", "finney") })

    auc = await auction.auctionsByToken(token.address, tokenId)
    expect(auc.highestBidder).equal(acc4.address)

    // acc3 already bid 0.2 before so he should be highest bidder
    await auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("200", "finney") })

    auc = await auction.auctionsByToken(token.address, tokenId)

    expect(auc.highestBidder).equal(acc3.address)

    await sleep(endTime * 1000)

    auc = await auction.auctionsByToken(token.address, tokenId)

    const sellerBalanceBeforeFinalize = await acc2.getBalance()
    const acc3BalanceBeforeFinalize = await acc3.getBalance()
    const acc4BalanceBeforeFinalize = await acc4.getBalance()
    const receiverOfFeesBalanceBeforeFinalize = await receiverOfFees.getBalance()

    let finalizePromise = await auction.connect(acc1).finalizeAuction(token.address, tokenId)

    await finalizePromise.wait()
    console.info("auction finalized by contract owner")

    const sellerBalanceAfterFinalize = await acc2.getBalance()
    const acc3BalanceAfterFinalize = await acc3.getBalance()
    const acc4BalanceAfterFinalize = await acc4.getBalance()
    const receiverOfFeesBalanceAfterFinalize = await receiverOfFees.getBalance()

    const highestBid = parseUnits("400", "finney")
    const fee = highestBid.mul(platformFee).div(100)
    const sellerShouldGet = highestBid.sub(fee)

    expect(
      areBigNumbersEqual(sellerBalanceAfterFinalize, sellerBalanceBeforeFinalize.add(sellerShouldGet)), "not equal2"
      ).equal(true);

    // acc3 won the auction so he shouldn't get enything back but he should have the nft
    expect((await token.balanceOf(acc3.address, tokenId)).eq(1), "not equal3").equal(true)
    expect(areBigNumbersEqual(acc3BalanceBeforeFinalize, acc3BalanceAfterFinalize), "not equal4").equal(true);

    // highest bidder tries to request payment
    expect(auction.connect(acc3).requestPayment(token.address, tokenId)).to.eventually.throw()


    // acc4 will reclaim his money because he didn't win
    expect(areBigNumbersEqual(acc4BalanceAfterFinalize, acc4BalanceBeforeFinalize.add(parseUnits("300", "finney"))), "not equal5").equal(true);
    // then tries to request payment
    expect(auction.connect(acc4).requestPayment(token.address, tokenId)).to.eventually.throw()

    // receiver of fees should get the fee
    expect(
      areBigNumbersEqual(receiverOfFeesBalanceAfterFinalize, receiverOfFeesBalanceBeforeFinalize.add(fee)), "not equal6"
      ).equal(true);

  })

  it("tests royalties", async function() {
    const [acc1, acc2, acc3, acc4] = await ethers.getSigners()
    const seller = (await ethers.getSigners()).slice(-2)[0]
    const { auction, token, tokenId, receiverOfFees, tokenMinter } = await init()
    await token.connect(tokenMinter).safeTransferFrom(tokenMinter.address, seller.address, tokenId, 1, []);

    const endTime = 7

    const platformFee = 4
    await auction.connect(acc1).setPlatformFee(platformFee)
    const royaltyFee = 7
    await auction.connect(tokenMinter).registerRoyalty(token.address, tokenId, royaltyFee)
    await token.connect(seller).setApprovalForAll(auction.address, true);

    await auction.connect(seller).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, 0, 0)

    await auction.connect(acc4).placeBid(token.address, tokenId, { value: parseUnits("300", "finney") })
    const highestBid = parseUnits("500", "finney")
    await auction.connect(acc3).placeBid(token.address, tokenId, { value: highestBid })

    await sleep(endTime * 1000)

    const sellerBalanceBeforeFinalize = await seller.getBalance()
    const receiverOfFeesBalanceBeforeFinalize = await receiverOfFees.getBalance()
    const tokenMinterBalanceBeforeFinalize = await tokenMinter.getBalance()

    let finalizePromise = await auction.connect(acc1).finalizeAuction(token.address, tokenId)

    await finalizePromise.wait()
    console.info("auction finalized by contract owner")

    const sellerBalanceAfterFinalize = await seller.getBalance()
    const receiverOfFeesBalanceAfterFinalize = await receiverOfFees.getBalance()
    const tokenMinterBalanceAfterFinalize = await tokenMinter.getBalance()

    const fee = highestBid.mul(platformFee).div(100)
    let sellerShouldGet = highestBid.sub(fee)
    // we compute royalty from the value minus the platform fee
    const royalty = sellerShouldGet.mul(royaltyFee).div(100)
    sellerShouldGet = sellerShouldGet.sub(royalty)

    expect(
      areBigNumbersEqual(sellerBalanceAfterFinalize, sellerBalanceBeforeFinalize.add(sellerShouldGet)), "not equal2"
      ).equal(true);

    // receiver of fees should get the fee
    expect(
      areBigNumbersEqual(receiverOfFeesBalanceAfterFinalize, receiverOfFeesBalanceBeforeFinalize.add(fee)), "not equal6"
      ).equal(true);

    // token minter should get the royalty
    expect(
      areBigNumbersEqual(tokenMinterBalanceAfterFinalize, tokenMinterBalanceBeforeFinalize.add(royalty)), "not equal7"
      ).equal(true);
  })

  it("fails on bid too low", async function() {
    const [_acc1, acc2, acc3, acc4] = await ethers.getSigners()
    const { auction, token, tokenId } = await init()

    const endTime = 60

    await auction.connect(acc2).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, 0, parseUnits("100", "finney"))

    const promise1 = auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("100", "finney") })
    expect(promise1).to.eventually.throw()

    // successful bid
    await auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("200", "finney") })

    const promise2 = auction.connect(acc4).placeBid(token.address, tokenId, { value: parseUnits("250", "finney") })
    expect(promise2).to.eventually.throw()
  })

  it("fails because you can't bid twice in a row", async function () {
    const [_acc1, acc2, acc3, acc4] = await ethers.getSigners()
    const { auction, token, tokenId } = await init()

    const endTime = 60

    await auction.connect(acc2).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, 0, parseUnits("100", "finney"))

    await auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("200", "finney") })

    expect(auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("200", "finney") })).to.eventually.throw()
  })

  it("tests bid increment", async function() {
    const [_acc1, acc2, acc3, acc4] = await ethers.getSigners()
    const { auction, token, tokenId } = await init()

    const endTime = 60

    const promise1 = auction.connect(acc2).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, 0, parseUnits("1", "gwei"))
    expect(promise1).to.eventually.throw()
    await promise1;

    // auction1
    await auction.connect(acc2).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, 0, parseUnits("101", "finney"))
    let auc = await auction.auctionsByToken(token.address, tokenId)
    expect(areBigNumbersEqual(auc.minBidDifference, parseUnits("101", "finney")))


    // auction2
    const tokenId2 = 2
    await token.mint(acc2.address, tokenId2, 2, 2, "whatfevs", []);

    await auction.connect(acc2).createAuction(token.address, tokenId2, 1, parseUnits("100", "finney"), 0, endTime, 0, 0)
    let auc2 = await auction.auctionsByToken(token.address, tokenId2)
    expect(areBigNumbersEqual(auc2.minBidDifference, await auction.MIN_BID_INCREMENT()))

    // auction2 - is still less than min bid increment
    const tokenId3 = 3
    await token.mint(acc2.address, tokenId3, 2, 2, "whatfevs", []);

    await auction.connect(acc2).createAuction(token.address, tokenId3, 1, parseUnits("100", "finney"), 0, endTime, 0, parseUnits("1", "gwei"))
    let auc3 = await auction.auctionsByToken(token.address, tokenId3)
    expect(areBigNumbersEqual(auc3.minBidDifference, await auction.MIN_BID_INCREMENT()))
  })

  it("tests prolong end time", async function() {
    const [_acc1, acc2, acc3, acc4, acc5] = await ethers.getSigners()
    const { auction, token, tokenId } = await init()

    const endTime = 60
    const prolongationInSeconds = 60 * 60

    const tx = await auction.connect(acc2).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, prolongationInSeconds, 0)
    let auc = await auction.auctionsByToken(token.address, tokenId)
    const writtenInitialEndTime = auc.endTime
    await auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("200", "finney") })

    auc = await auction.auctionsByToken(token.address, tokenId)
    expect(auc.endTime.toNumber()).equals(writtenInitialEndTime.toNumber() + prolongationInSeconds)

    await auction.connect(acc4).placeBid(token.address, tokenId, { value: parseUnits("400", "finney") })
    await auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("800", "finney") })

    auc = await auction.auctionsByToken(token.address, tokenId)
    expect(auc.endTime.toNumber()).equals(writtenInitialEndTime.toNumber() + prolongationInSeconds * 3)
  })

  it("tests token amount 1", async function() {
    const [_acc1, acc2, acc3, acc4, acc5] = await ethers.getSigners()
    const { auction, token } = await init()

    const tokenId = 3
    const tokenAmountMinted = 3

    await token.mint(acc2.address, tokenId, tokenAmountMinted, tokenAmountMinted, "whatfevs", []);

    const endTime = 8

    // auction less then owned
    let auctionedAmount = 1
    await auction.connect(acc2).createAuction(token.address, tokenId, auctionedAmount, parseUnits("100", "finney"), 0, endTime, 0, 0)
    await auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("500", "finney") })

    await sleep(endTime * 1000);

    await auction.connect(acc3).transferTokenToHighestBidder(token.address, tokenId)

    expect(await token.balanceOf(acc3.address, tokenId)).equals(auctionedAmount)

    // auction more than owned
    expect(auction.connect(acc2).createAuction(token.address, tokenId, 5, parseUnits("100", "finney"), 0, endTime, 0, 0)).to.eventually.throw()
  })

  it("tests token amount 2", async function() {
    const [_acc1, acc2, acc3, acc4, acc5] = await ethers.getSigners()
    const { auction, token } = await init()

    const tokenId = 3
    const tokenAmountMinted = 3

    await token.mint(acc2.address, tokenId, tokenAmountMinted, tokenAmountMinted, "whatfevs", []);

    const endTime = 8

    // auctions all owned
    await auction.connect(acc2).createAuction(token.address, tokenId, tokenAmountMinted, parseUnits("100", "finney"), 0, endTime, 0, 0)
    await auction.connect(acc4).placeBid(token.address, tokenId, { value: parseUnits("500", "finney") })

    await sleep(endTime * 1000);

    await auction.connect(acc4).transferTokenToHighestBidder(token.address, tokenId)

    expect(await token.balanceOf(acc4.address, tokenId)).equals(tokenAmountMinted)
  })

  it("tests cancel auction 1", async function() {
    const [_acc1, acc2, acc3, acc4, acc5] = await ethers.getSigners()
    const { auction, token, tokenId } = await init()

    const starTime = 300
    const endTime = 600

    // auction starts in the future
    await auction.connect(acc2).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), starTime, endTime, 0, 0)
    await auction.connect(acc2).cancelAuction(token.address, tokenId)

    const auc = await auction.auctionsByToken(token.address, tokenId)
    expect(auc.cancelled).equals(true)
  })

  it("tests cancel auction 2", async function() {
    const [_acc1, acc2, acc3, acc4, acc5] = await ethers.getSigners()
    const { auction, token, tokenId } = await init()

    const endTime = 600

    await auction.connect(acc2).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, 0, 0)
    await auction.connect(acc2).cancelAuction(token.address, tokenId)

    const auc = await auction.auctionsByToken(token.address, tokenId)
    expect(auc.cancelled).equals(true)

    expect(auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("200", "finney") })).to.eventually.throw()
  })

  it("tests not seller tries to cancel auction", async function() {
    const [acc1, acc2, acc3, acc4, acc5] = await ethers.getSigners()
    const { auction, token, tokenId } = await init()

    const endTime = 600

    await auction.connect(acc2).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, 0, 0)

    // owner tries
    expect(auction.connect(acc1).cancelAuction(token.address, tokenId)).to.eventually.throw()

    await auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("200", "finney") })

    // bidder tries
    expect(auction.connect(acc3).cancelAuction(token.address, tokenId)).to.eventually.throw()
  })

  it("claim money after cancel", async function() {
    const [_acc1, acc2, acc3, acc4, acc5] = await ethers.getSigners()
    const { auction, token, tokenId } = await init()

    const endTime = 600

    await auction.connect(acc2).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, 0, 0)

    auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("200", "finney") })
    auction.connect(acc4).placeBid(token.address, tokenId, { value: parseUnits("600", "finney") })

    await auction.connect(acc2).cancelAuction(token.address, tokenId)

    // seller tries
    expect(auction.connect(acc2).requestPayment(token.address, tokenId)).to.eventually.throw()

    // regular bidder
    const acc3BalanceBeforeRequest = await acc3.getBalance()
    const tx1 = await auction.connect(acc3).requestPayment(token.address, tokenId)

    const acc3BalanceAfterRequest = await acc3.getBalance()

    let { gasUsed } = await tx1.wait()

    expect(
      areBigNumbersEqual(acc3BalanceAfterRequest, acc3BalanceBeforeRequest.sub(gasUsed).add(parseUnits("200", "finney"))), "acc3 balance errr"
    ).equal(true);

    // highest bidder
    const acc4BalanceBeforeRequest = await acc4.getBalance()
    const tx2 = await auction.connect(acc4).requestPayment(token.address, tokenId)
    const acc4BalanceAfterRequest = await acc4.getBalance()

    gasUsed = (await tx2.wait()).gasUsed

    expect(
      areBigNumbersEqual(acc4BalanceAfterRequest, acc4BalanceBeforeRequest.sub(gasUsed).add(parseUnits("600", "finney"))), "acc4 balance errr"
    ).equal(true);

    // highet bidder tries again
    expect(auction.connect(acc4).requestPayment(token.address, tokenId)).to.eventually.throw()


    // random guy tries
    expect(auction.connect(acc5).requestPayment(token.address, tokenId)).to.eventually.throw()
  })

  it("tests create auction with invalid token", async function() {
    const [_acc1, acc2, acc3] = await ethers.getSigners()
    const { auction, token, tokenId } = await init()

    const endTime = 600

    expect(auction.connect(acc2).createAuction(token.address, 666, 1, parseUnits("100", "finney"), 0, endTime, 0, 0)).to.eventually.throw()
    expect(auction.connect(acc2).createAuction(acc3.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, 0, 0)).to.eventually.throw()
  })

  it("tests token no longer valid", async function() {
    const [acc1, acc2, acc3, acc4, acc5] = await ethers.getSigners()
    const { auction, token, tokenId } = await init()

    const endTime = 6

    await auction.connect(acc2).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, 0, 0)

    await auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("200", "finney") })
    await auction.connect(acc4).placeBid(token.address, tokenId, { value: parseUnits("600", "finney") })

    // cancels approval
    const tx = await token.connect(acc2).setApprovalForAll(auction.address, false)
    // await tx.wait()

    // can't bid anymore
    expect(auction.connect(acc5).placeBid(token.address, tokenId, { value: parseUnits("1200", "finney") })).to.eventually.throw()

    await sleep(endTime * 1000)

    expect(auction.connect(acc1).finalizeAuction(token.address, tokenId)).to.eventually.throw()

    // seller can't claim money
    expect(auction.connect(acc2).requestPayment(token.address, tokenId)).to.eventually.throw()

    // highest bidder can't get token
    expect(auction.connect(acc4).transferTokenToHighestBidder(token.address, tokenId)).to.eventually.throw()

    // highest bidder can claim money
    const acc4BalanceBeforeRequest = await acc4.getBalance()
    const tx2 = await auction.connect(acc4).requestPayment(token.address, tokenId)
    let { gasUsed } = await tx2.wait()
    const acc4BalanceAfterRequest = await acc4.getBalance()

    expect(
      areBigNumbersEqual(acc4BalanceAfterRequest, acc4BalanceBeforeRequest.sub(gasUsed).add(parseUnits("600", "finney"))), "acc4 balance errr"
    ).equal(true);

    // regular bidder can claim money
    const acc3BalanceBeforeRequest = await acc3.getBalance()
    const tx1 = await auction.connect(acc3).requestPayment(token.address, tokenId)
    gasUsed = (await tx1.wait()).gasUsed
    const acc3BalanceAfterRequest = await acc3.getBalance()

    expect(
      areBigNumbersEqual(acc3BalanceAfterRequest, acc3BalanceBeforeRequest.sub(gasUsed).add(parseUnits("200", "finney"))), "acc3 balance errr"
    ).equal(true);
  })

  it("tests bidding a small amount", async function() {
    const [acc1, acc2, acc3, acc4, acc5] = await ethers.getSigners()
    const { auction, token, tokenId } = await init()

    const endTime = 600

    try {
      await auction.connect(acc2).createAuction(token.address, tokenId, 1, parseUnits("100", "finney"), 0, endTime, 0, parseUnits("1", "finney"))
      await auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("101", "finney") })
      await auction.connect(acc4).placeBid(token.address, tokenId, { value: parseUnits("102", "finney") })
      await auction.connect(acc3).placeBid(token.address, tokenId, { value: parseUnits("2", "finney") })
    } catch {
      expect(false).equals(true)
    }

  })
});
