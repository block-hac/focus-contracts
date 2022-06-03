require("dotenv").config();
const axios = require("axios");
const ethers = require("ethers");
const mongoose = require("mongoose");
const ERC1155CONTRACT = mongoose.model("ERC1155CONTRACT");
const NFTITEM = mongoose.model("NFTITEM");
const ERC1155HOLDING = mongoose.model("ERC1155HOLDING");
const SimplifiedERC1155ABI = require("../constants/simplified1155abi");
const provider = new ethers.providers.JsonRpcProvider(
  process.env.NETWORK_RPC,
  parseInt(process.env.NETWORK_CHAINID),
);
const toLowerCase = val => {
  if (val) return val.toLowerCase();
  else return val;
};
// xtract address from ST Evt topics
const extractAddress = data => {
  let length = data.length;
  return data.substring(0, 2) + data.substring(length - 40);
};
// get tokenID & total supply from data
const parseSingleTrasferData = data => {
  return [parseInt(data.substring(0, 66), 16), parseInt(data.substring(66), 16)];
};
const parseBatchTransferData = data => {
  let tokenIDs = [];
  data = data.substring(2);
  let segments = data.length / 64;
  let tkCount = segments / 2;
  let tkData = data.substring(64 * 3, 64 * (tkCount + 1));
  for (let i = 0; i < tkData.length / 64; ++i) {
    let _tkData = tkData.substring(i * 64, (i + 1) * 64);
    let tokenID = parseInt(_tkData.toString(), 16);
    tokenIDs.push(tokenID);
  }
  return tokenIDs;
};
const getSupplyPerAddress = async (tokenID, address, contract) => {
  let supply = await contract.balanceOf(address, parseInt(tokenID));
  return supply;
};
const parseURIHexToString = data => {
  let utf8String = ethers.utils.toUtf8String(data.substring(0, 2) + data.substring(130));
  utf8String = utf8String.replace(/[^A-Za-z0-9//:/.-_]/g, "");
  return utf8String;
};
const validatorAddress = "0x0000000000000000000000000000000000000000";
// store trackedAddresses
const trackedAddresses = [];
const trackedSCs = [];
const analyzeEvents = async (address, contract) => {
  /* map for total supplies per tokenID*/
  const supplies = new Map(); //  tokenID => total supply
  /* map for token uri per tokenID*/
  const tokenUris = new Map(); //  tokenID => tokenURI
  /* map for holders per tokenID*/
  const holders = new Map(); //tokenID => address[]
  const blockNumbersMap = new Map(); // contractAddress-tokenID => blockNumber
  let cbh = await provider.getBlockNumber(); //current block height
  // get all single transfer events
  let ste = await provider.getLogs({
    address: address,
    fromBlock: 0,
    toBlock: cbh,
    topics: [ethers.utils.id("TransferSingle(address,address,address,uint256,uint256)")],
  });
  // get all URI events
  let urie = await provider.getLogs({
    address: address,
    fromBlock: 0,
    toBlock: cbh,
    topics: [ethers.utils.id("URI(string,uint256)")],
  });
  // get all batch transfer events
  let bte = await provider.getLogs({
    address: address,
    fromBlock: 0,
    toBlock: cbh,
    topics: [ethers.utils.id("TransferBatch(address,address,address,uint256[],uint256[])")],
  });
  //   loop single transfer events first along with uri event
  for (let i = 0; i < ste.length; ++i) {
    //loop singe transfer evt
    let singleTransferEvt = ste[i];
    let uriEvt = urie[i];
    let stTopics = singleTransferEvt.topics;
    let stData = singleTransferEvt.data;
    let uriData = null;
    try {
      uriData = uriEvt.data;
    } catch (error) {}
    let sender = extractAddress(stTopics[2]);
    sender = toLowerCase(sender);
    let receiver = extractAddress(stTopics[3]);
    receiver = toLowerCase(receiver);
    let contractAddress = toLowerCase(singleTransferEvt.address);
    let blockNumber = parseInt(singleTransferEvt.blockNumber);
    stData = parseSingleTrasferData(stData);
    let tokenID = stData[0];
    let supply = stData[1];
    let tokenURI = 'https"//';
    try {
      tokenURI = parseURIHexToString(uriData);
    } catch (error) {}
    // when this is a mint evt, log total supply & token uri
    if (sender == validatorAddress) {
      supplies.set(tokenID, supply);
      tokenUris.set(tokenID, tokenURI);
      blockNumbersMap.set(contractAddress + "-" + tokenID, blockNumber);
    }
    /* add unseen addresses per tokenID */
    let holdersPerTkID = holders.get(tokenID);
    if (holdersPerTkID) {
      // when there is a registered array for a particular tokenID
      if (!holdersPerTkID.includes(sender))
        if (sender != validatorAddress) holdersPerTkID.push(sender);
      if (!holdersPerTkID.includes(receiver)) holdersPerTkID.push(receiver);
      holders.set(tokenID, holdersPerTkID);
    } else {
      let _holdersPerTkID = [];
      if (sender != validatorAddress) _holdersPerTkID.push(sender);
      _holdersPerTkID.push(receiver);
      holders.set(tokenID, _holdersPerTkID);
    }
  } //loop singe transfer evt
  /* now loop the batch transfer event */
  for (let i = 0; i < bte.length; ++i) {
    let batchTransferEvt = bte[i];
    let bteTopics = batchTransferEvt.topics;
    let bteData = batchTransferEvt.data;
    let sender = bteTopics[2];
    let receiver = bteTopics[3];
    sender = toLowerCase(extractAddress(sender)); // sender
    receiver = toLowerCase(extractAddress(receiver)); // receiver
    let ids = parseBatchTransferData(bteData);
    ids.map(tokenID => {
      /* add unseen addresses per tokenID */
      let holdersPerTkID = holders.get(tokenID);
      if (holdersPerTkID) {
        // when there is a registered array for a particular tokenID
        if (!holdersPerTkID.includes(sender))
          if (sender != validatorAddress) holdersPerTkID.push(toLowerCase(sender));
        if (!holdersPerTkID.includes(receiver)) holdersPerTkID.push(toLowerCase(receiver));
        holders.set(tokenID, holdersPerTkID);
      } else {
        let _holdersPerTkID = [];
        if (sender != validatorAddress) _holdersPerTkID.push(sender);
        _holdersPerTkID.push(receiver);
        holders.set(tokenID, _holdersPerTkID);
      }
    });
    /* extract tokenIDs & corrensponding transfered values from data */
  }
  let tkIDs = holders.keys();
  let tkID = tkIDs.next().value;
  while (tkID) {
    let holderAddrs = holders.get(tkID);
    let _savedTk = await NFTITEM.findOne({
      contractAddress: address,
      tokenID: tkID,
    });
    let ownerMap = new Map();
    if (_savedTk) {
      let owners = _savedTk.owner;
      let ownerAddrs = owners.keys();
      let _ownerAddr = ownerAddrs.next().value;
      while (_ownerAddr) {
        if (!holderAddrs.includes(_ownerAddr)) holderAddrs.push(_ownerAddr);
      }
      let promise = holderAddrs.map(async holderAddr => {
        let supply = await getSupplyPerAddress(tkID, holderAddr, contract);
        supply = parseInt(supply.toString());
        ownerMap.set(holderAddr, supply);
      });
      await Promise.all(promise);
      //   now save a token
      _savedTk.tokenURI = tokenUris.get(tkID);
      _savedTk.owner = ownerMap;
      _savedTk.supply = supplies.get(tkID);
      try {
        await _savedTk.save();
      } catch (error) {}
      tkID = tkIDs.next().value;
    } else {
      let promise = holderAddrs.map(async holderAddr => {
        let supply = await getSupplyPerAddress(tkID, holderAddr, contract);
        supply = parseInt(supply.toString());
        ownerMap.set(holderAddr, supply);
      });
      await Promise.all(promise);
      let savingTk = new NFTITEM();
      savingTk.contractAddress = address;
      savingTk.tokenID = tkID;
      let uri = tokenUris.get(tkID);
      savingTk.tokenURI = uri;
      savingTk.tokenType = 1155;
      let name = "";
      let imageURL = "";
      try {
        let metadata = await axios.get(uri);
        metadata = metadata.data;
        name = metadata.name;
        imageURL = metadata.image;
      } catch (error) {
        console.log(error);
      }
      savingTk.name = name;
      savingTk.imageURL = imageURL;
      savingTk.symbol = "symbol";
      // save the erc1155 holdings instead here
      let holderAddresses = ownerMap.keys();
      let holderAddress = holderAddresses.next().value;
      while (holderAddress) {
        let supplyPerHolder = parseInt(ownerMap.get(holderAddress));
        let erc1155holdings = new ERC1155HOLDING();
        erc1155holdings.contractAddress = address;
        erc1155holdings.tokenID = tkID;
        erc1155holdings.holderAddress = holderAddress;
        erc1155holdings.supplyPerHolder = supplyPerHolder;
        try {
          if (supplyPerHolder > 0) await erc1155holdings.save();
        } catch (error) {
        } finally {
          holderAddress = holderAddresses.next().value;
        }
      }
      let blockNumber = blockNumbersMap.get(address + "-" + tkID);
      let block = await provider.getBlock(blockNumber);
      let blockTime = parseInt(block.timestamp) * 1000;
      savingTk.createdAt = new Date(blockTime);
      savingTk.supply = supplies.get(tkID);
      try {
        await savingTk.save();
      } catch (error) {
        console.log(error);
      }
      tkID = tkIDs.next().value;
    }
  }
};
const track1155Distribution = async () => {
  //track 1155 dist
  const func = async () => {
    try {
      let untrackedSCs = await ERC1155CONTRACT.find({
        address: { $nin: trackedAddresses },
      });
      if (untrackedSCs) {
        let promise = untrackedSCs.map(async sc => {
          let address = sc.address;
          trackedAddresses.push(address);
          let abi = SimplifiedERC1155ABI;
          let contract = new ethers.Contract(address, abi, provider);
          trackedSCs.push(contract);
          await analyzeEvents(address, contract);
        });
      }
    } catch (error) {}
    setTimeout(async () => {
      await func();
    }, 1000 * 60 * 10); //repeat every 10 secs for now
  };
  await func();
}; //track 1155 dist
module.exports = track1155Distribution;
