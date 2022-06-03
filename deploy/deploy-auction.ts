import { Contract, ContractFactory } from "ethers";
// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
// When running the script with `hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
import { ethers, upgrades } from "hardhat";

async function deploy() {
  if (!process.env.FEE_RECIPIENT_ADDRESS) {
    throw new Error("Missing FEE_RECIPIENT_ADDRESS env variable");
  }

  if (!process.env.PLATFORM_FEE_PERCENT) {
    throw new Error("Missing PLATFORM_FEE_PERCENT env variable");
  }

  const FocusAuction = await ethers.getContractFactory("FocusAuction");
  const auction = await FocusAuction.deploy(process.env.FEE_RECIPIENT_ADDRESS, parseInt(process.env.PLATFORM_FEE_PERCENT));
  await auction.deployed();

  console.log("FocusAuction deployed to: ", auction.address);
}

async function main(): Promise<void> {
  await deploy();
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
