require("dotenv").config();
const { default: axios } = require("axios");
const ethers = require("ethers");
const mongoose = require("mongoose");
const ERC1155CONTRACT = mongoose.model("ERC1155CONTRACT");
const NFTITEM = mongoose.model("NFTITEM");
const ERC1155HOLDING = mongoose.model("ERC1155HOLDING");
const BannedNFT = mongoose.model("BannedNFT");
const SimplifiedERC1155ABI = require("../constants/simplified1155abi");
const provider = new ethers.providers.JsonRpcProvider(
  process.env.NETWORK_RPC,
  parseInt(process.env.NETWORK_CHAINID),
);
const toLowerCase = val => {
  if (val) return val.toLowerCase();
  else return val;
};
const validatorAddress = "0x0000000000000000000000000000000000000000";
// store trackedAddresses
const trackedAddresses = [];
const trackedSCs = [];
const trackNewERC1155 = async () => {
  const func = async () => {
    try {
      let untrackedSCs = await ERC1155CONTRACT.find({
        address: { $nin: trackedAddresses },
      });
      if (untrackedSCs) {
        // when there are some untracked addresses
        let promise = untrackedSCs.map(async sc => {
          let address = sc.address;
          trackedAddresses.push(address);
          let abi = SimplifiedERC1155ABI;
          let contract = new ethers.Contract(address, abi, provider);
          trackedSCs.push(contract);
          // register tracker here
          contract.on("TransferSingle", async (operator, from, to, id, value) => {
            console.log("transfer single");
            operator = toLowerCase(operator);
            from = toLowerCase(from);
            to = toLowerCase(to);
            id = parseFloat(id.toString());
            value = parseFloat(value.toString());
            try {
              if (from == validatorAddress) {
                // this is a new mint
                let tk = await NFTITEM.findOne({
                  contractAddress: address,
                  tokenID: id,
                });
                if (!tk) {
                  try {
                    let bannedItem = await BannedNFT.findOne({
                      contractAddress: address,
                      tokenID: id,
                    });
                    if (bannedItem) {
                    } else {
                      let newTk = new NFTITEM();
                      newTk.contractAddress = address;
                      newTk.tokenID = id;
                      newTk.supply = value;
                      newTk.createdAt = new Date();
                      newTk.tokenURI = "https://";
                      newTk.tokenType = 1155;
                      await newTk.save();
                    }
                  } catch (error) {
                    console.log("error in saving new tk in single transfer");
                    console.log(error);
                  }
                  try {
                    // now update the holdings collection
                    let holding = new ERC1155HOLDING();
                    holding.contractAddress = address;
                    holding.tokenID = id;
                    holding.holderAddress = to;
                    holding.supplyPerHolder = value;
                    await holding.save();
                  } catch (error) {
                    console.log("error in saving new holding in single transfer");
                  }
                }
              } else {
                // first deduct from sender - from
                let senderHolding = await ERC1155HOLDING.findOne({
                  contractAddress: address,
                  tokenID: id,
                  holderAddress: from,
                });
                if (senderHolding) {
                  try {
                    senderHolding.supplyPerHolder = parseInt(senderHolding.supplyPerHolder - value);
                    await senderHolding.save();
                  } catch (error) {
                    console.log("sender holding save failed");
                    console.log(error);
                  }
                }
                // now add to receiver - to
                let receiverHolding = await ERC1155HOLDING.findOne({
                  contractAddress: address,
                  tokenID: id,
                  holderAddress: to,
                });
                if (receiverHolding) {
                  try {
                    receiverHolding.supplyPerHolder =
                      parseInt(receiverHolding.supplyPerHolder) + value;
                    await receiverHolding.save();
                  } catch (error) {
                    console.log("receiver holding failed in single transfer");
                    console.log(error);
                  }
                } else {
                  try {
                    let _receiverHolding = new ERC1155HOLDING();
                    _receiverHolding.contractAddress = address;
                    _receiverHolding.tokenID = id;
                    _receiverHolding.holderAddress = to;
                    _receiverHolding.supplyPerHolder = value;
                    await _receiverHolding.save();
                  } catch (error) {
                    console.log("error in single transfer updating receiver");
                    console.log(error);
                  }
                }
              }
            } catch (error) {
              console.log("overall error");
              console.log(error);
            }
          });
          contract.on("TransferBatch", async (operator, from, to, ids, values) => {
            let promises = ids.map(async (_, index) => {
              operator = toLowerCase(operator);
              from = toLowerCase(from);
              to = toLowerCase(to);
              let id = ids[index];
              id = parseFloat(id.toString());
              let value = values[index];
              value = parseFloat(value.toString());
              try {
                if (from == validatorAddress) {
                  let tk = await NFTITEM.findOne({
                    contractAddress: address,
                    tokenID: id,
                  });
                  if (!tk) {
                    try {
                      let bannedItem = await BannedNFT.findOne({
                        contractAddress: address,
                        tokenID: id,
                      });
                      if (bannedItem) {
                      } else {
                        let newTk = new NFTITEM();
                        newTk.contractAddress = address;
                        newTk.tokenID = id;
                        newTk.supply = value;
                        newTk.createdAt = new Date();
                        newTk.tokenURI = "https://";
                        newTk.tokenType = 1155;
                        await newTk.save();
                      }
                    } catch (error) {
                      console.log("error in saving new tk");
                      console.log(error);
                    }
                    try {
                      // update holding here
                      let holding = new ERC1155HOLDING();
                      holding.contractAddress = address;
                      holding.holderAddress = to;
                      holding.tokenID = id;
                      holding.supplyPerHolder = value;
                      await holding.save();
                    } catch (error) {
                      console.log("single transfer save new holding error");
                      console.log(error);
                    }
                  }
                } else {
                  // first deduct from sender - from
                  let senderHolding = await ERC1155HOLDING.findOne({
                    contractAddress: address,
                    tokenID: id,
                    holderAddress: from,
                  });
                  if (senderHolding) {
                    try {
                      senderHolding.supplyPerHolder = parseInt(
                        senderHolding.supplyPerHolder - value,
                      );
                      await senderHolding.save();
                    } catch (error) {
                      console.log("error in batch transfer updating existing sender");
                      console.log(error);
                    }
                  }
                  // now add to receiver - to
                  let receiverHolding = await ERC1155HOLDING.findOne({
                    contractAddress: address,
                    tokenID: id,
                    holderAddress: to,
                  });
                  if (receiverHolding) {
                    try {
                      receiverHolding.supplyPerHolder =
                        parseInt(receiverHolding.supplyPerHolder) + value;
                      await receiverHolding.save();
                    } catch (error) {
                      console.log("error in batch transfer updating receiver holding");
                      console.log(error);
                    }
                  } else {
                    try {
                      let _receiverHolding = new ERC1155HOLDING();
                      _receiverHolding.contractAddress = address;
                      _receiverHolding.tokenID = id;
                      _receiverHolding.holderAddress = to;
                      _receiverHolding.supplyPerHolder = value;
                      await _receiverHolding.save();
                    } catch (error) {
                      console.log("batch transfer cannot save new holding");
                      console.log(error);
                    }
                  }
                }
              } catch (error) {
                console.log("batch transfer error");
                console.log(error);
              }
            });
            Promise.all(promises);
          });
          contract.on("URI", async (value, id) => {
            console.log("uri 1");
            setTimeout(async () => {
              id = parseFloat(id.toString());
              let tk = await NFTITEM.findOne({
                contractAddress: address,
                tokenID: id,
              });
              if (!tk) {
              } else {
                let _tkURI = tk.tokenURI;
                if (_tkURI == "https://") {
                  tk.tokenURI = value;
                  try {
                    let metadata = await axios.get(_tkURI);
                    let name = metadata.data.name;
                    let imageURL = metadata.data.image;
                    tk.imageURL = imageURL;
                    tk.name = name;
                  } catch (error) {
                    tk.name = "";
                  }
                }
                await tk.save();
              }
            }, 1000);
          });
        });
        await Promise.all(promise);
      }
      setTimeout(async () => {
        await func();
      }, 1000 * 10);
    } catch (error) {}
  };
  await func();
};
module.exports = trackNewERC1155;
