//SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "openzeppelin-solidity/contracts/utils/introspection/IERC165.sol";
import "openzeppelin-solidity/contracts/token/ERC1155/IERC1155.sol";

interface IFocusNFT1155 {
    function creators(uint256) external returns (address);
}

contract FocusAuction {
    event AuctionCanceled(address nftAddress, uint256 tokenId);
    event AuctionCreated(
        address nftAddress,
        uint256 tokenId,
        address seller,
        uint256 startTime,
        uint256 endTime,
        uint256 initialPrice,
        uint256 prolongEndTimeAtBidBySeconds,
        uint256 minBidDifference,
        uint256 amount
    );
    event BidPlaced(
        address nftAddress,
        uint256 tokenId,
        address bidder,
        uint256 value,
        uint256 fullBid,
        uint256 endTime,
        address seller
    );

    bytes4 private constant INTERFACE_ID_ERC1155 = 0xd9b67a26;

    // 182 days - 26 weeks - 6 months
    uint256 public constant MAX_BID_DURATION = 182 days;
    uint256 public constant MIN_BID_DURATION = 3 seconds;
    uint256 public constant MIN_BID_INCREMENT = 10_000 gwei;

    address public owner;

    address public feeRecipient;
    uint8 public platformFee;

    struct BidInfo {
        address bidder;
        uint256 bidValue;
    }

    struct Auction {
        bool cancelled;
        bool tokenTransactionDone;
        bool sellerPaid;
        mapping(address => uint) bids;
        BidInfo[] bidsInOrder;
        address highestBidder;
        address seller;
        uint256 startTime;
        uint256 endTime;
        uint256 initialPrice;
        uint256 prolongEndTimeAtBidBySeconds;
        uint256 minBidDifference;
        uint256 amount;
    }

    /// @notice tokenAddress => tokenId => Auction
    mapping(address => mapping(uint256 => Auction)) public auctionsByToken;

    /// @notice NftAddress -> Token ID -> Royalty
    mapping(address => mapping(uint256 => uint8)) public royalties;

    // declaring function modifiers
    modifier afterStart(address _nftAddress, uint256 _tokenId){
        Auction storage _auction = auctionsByToken[_nftAddress][_tokenId];
        require(block.timestamp > _auction.startTime, "auction didn't start yet");
        _;
    }

    modifier beforeEnd(address _nftAddress, uint256 _tokenId){
        Auction storage _auction = auctionsByToken[_nftAddress][_tokenId];
        require(block.timestamp < _auction.endTime, "auction ended");
        _;
    }

    modifier onlyOwner() {
        require(_msgSender() == owner, "Sender is not the owner");
        _;
    }

    constructor(address _feeRecipient, uint8 _platformFee){
        owner = payable(msg.sender);
        setPlatformFee(_platformFee);
        setFeeRecipient(_feeRecipient);
    }

    function setPlatformFee(uint8 _platformFee) public onlyOwner {
        require(_platformFee <= 50, "Platform fee mustn't be more than 50%");
        platformFee = _platformFee;
    }

    function setFeeRecipient(address _feeRecipient) public onlyOwner {
        require(_feeRecipient != address(0), "Address for receiver of fees not set");
        feeRecipient = _feeRecipient;
    }

    function _msgSender() internal view returns (address) {
        return msg.sender;
    }

    function _auctionTokenIsValidAndApproved(
        address _nftAddress,
        uint256 _tokenId,
        address _seller,
        uint256 _amount
    ) internal view returns(bool) {
        // todo can we afford trust that the contract is not malicious?
        if (IERC165(_nftAddress).supportsInterface(INTERFACE_ID_ERC1155)) {
            IERC1155 nft = IERC1155(_nftAddress);
            if(nft.balanceOf(_seller, _tokenId) < _amount) {
                return false;
            }
            if(nft.isApprovedForAll(_seller, address(this)) == false) {
                return false;
            }

            return true;
        } else {
            return false;
        }
    }

    function _requireAuctionTokenIsValidAndApproved(
        address _nftAddress,
        uint256 _tokenId,
        address _seller,
        uint256 _amount
    ) internal view returns(IERC1155) {
        if (IERC165(_nftAddress).supportsInterface(INTERFACE_ID_ERC1155)) {
            IERC1155 nft = IERC1155(_nftAddress);
            require(nft.balanceOf(_seller, _tokenId) >= _amount, "Must hold enough NFTs.");
            require(
                nft.isApprovedForAll(_seller, address(this)),
                "Token must be approved for auction."
            );

            return nft;
        } else {
            revert("Invalid NFT address.");
        }
    }

    function _getExistingAuction(address _nftAddress, uint256 _tokenId) internal view returns(Auction storage) {
        Auction storage newAuction = auctionsByToken[_nftAddress][_tokenId];

        require(newAuction.seller != address(0), "Auction doesn't exist");

        return newAuction;
    }

    function createAuction(
        address _nftAddress,
        uint256 _tokenId,
        uint256 _amount,
        uint256 _initialPrice,
        uint256 _startTime,
        uint256 _endTime,
        uint256 _prolongEndTimeAtBidBySeconds,
        uint256 _minBidDifference
    ) public {
        require(_initialPrice > 0, "Initial price must be bigger than 0");
        require(_prolongEndTimeAtBidBySeconds < 4 weeks, "prolongEndTimeAtBidBySeconds is longer than a month");
        uint256 minBidDifference = _minBidDifference > MIN_BID_INCREMENT ? _minBidDifference : MIN_BID_INCREMENT;

        uint256 auctionDuration = _endTime - _startTime;

        require(auctionDuration >= MIN_BID_DURATION, "Auction time too short.");
        require(auctionDuration <= MAX_BID_DURATION, "Auction time too long.");

        _requireAuctionTokenIsValidAndApproved(_nftAddress, _tokenId, _msgSender(), _amount);

        Auction storage newAuction = auctionsByToken[_nftAddress][_tokenId];

        newAuction.seller = _msgSender();
        newAuction.startTime = block.timestamp + _startTime;
        newAuction.endTime = block.timestamp + _endTime;
        newAuction.initialPrice = _initialPrice;
        newAuction.prolongEndTimeAtBidBySeconds = _prolongEndTimeAtBidBySeconds;
        newAuction.minBidDifference = minBidDifference;
        newAuction.amount = _amount;

        emit AuctionCreated(
            _nftAddress,
            _tokenId,
            newAuction.seller,
            newAuction.startTime,
            newAuction.endTime,
            newAuction.initialPrice,
            newAuction.prolongEndTimeAtBidBySeconds,
            newAuction.minBidDifference,
            newAuction.amount
        );
    }

    function getBidders(
        address _nftAddress,
        uint256 _tokenId
    ) public view returns(BidInfo[] memory) {
        Auction storage auction = _getExistingAuction(_nftAddress, _tokenId);

        return auction.bidsInOrder;
    }

    function getCurrentBid(
        address _nftAddress,
        uint256 _tokenId,
        address _bidderAddress
    ) public view returns(uint256) {
        Auction storage auction = _getExistingAuction(_nftAddress, _tokenId);

        return auction.bids[_bidderAddress];
    }

    // only the seller can cancel the Auction
    function cancelAuction(address _nftAddress, uint256 _tokenId) public beforeEnd(_nftAddress, _tokenId) {
        Auction storage auction = _getExistingAuction(_nftAddress, _tokenId);

        require(auction.seller == _msgSender(), "Only the seller can cancel the auction");
        require(auction.cancelled == false, "Auction is already cancelled");
        require(auction.tokenTransactionDone == false, "Token transaction already done");
        require(auction.sellerPaid == false, "Seller already paid");

        auction.cancelled = true;

        emit AuctionCanceled(_nftAddress, _tokenId);
    }

    function placeBid(
        address _nftAddress,
        uint256 _tokenId
    ) public payable afterStart(_nftAddress, _tokenId) beforeEnd(_nftAddress, _tokenId) {
        Auction storage auction = _getExistingAuction(_nftAddress, _tokenId);

        if(_auctionTokenIsValidAndApproved(_nftAddress, _tokenId, auction.seller, auction.amount) == false) {
            revert("auction is no longer valid");
        }

        address sender = _msgSender();

        require(auction.cancelled == false, "Auction is cancelled");

        require(sender != auction.seller, "seller cannot bid");
        require(sender != auction.highestBidder, "Sender already is the highest bidder");

        uint currentBid = auction.bids[sender] + msg.value;

        if(auction.highestBidder == address(0)) {
            require(currentBid >= auction.initialPrice + auction.minBidDifference, "Bid not high enough");
        }

        require(currentBid >= auction.bids[auction.highestBidder] + auction.minBidDifference, "Bid not high enough");

        auction.bids[sender] = currentBid;
        auction.highestBidder = sender;
        auction.bidsInOrder.push(BidInfo({ bidder: sender, bidValue: msg.value }));

        auction.endTime += auction.prolongEndTimeAtBidBySeconds;

        emit BidPlaced(
            _nftAddress,
            _tokenId,
            sender,
            msg.value,
            currentBid,
            auction.endTime,
            auction.seller
        );
    }

    function transferTokenToHighestBidder(
        address _nftAddress,
        uint256 _tokenId
    ) public afterStart(_nftAddress, _tokenId) {
        Auction storage auction = _getExistingAuction(_nftAddress, _tokenId);

        address sender = _msgSender();

        // the auction has been Canceled or Ended
        require(auction.cancelled || block.timestamp > auction.endTime, "not end of auction yet");

        require(sender == auction.seller || sender == owner || sender == auction.highestBidder, "not authorized");

        if(auction.tokenTransactionDone == false) {
            IERC1155 nft = _requireAuctionTokenIsValidAndApproved(_nftAddress, _tokenId, auction.seller, auction.amount);

            auction.tokenTransactionDone = true;
            nft.safeTransferFrom(auction.seller, auction.highestBidder, _tokenId, auction.amount, "");
        }
    }

    function _paySeller(
        address _nftAddress,
        uint256 _tokenId
    ) internal {
        Auction storage auction = _getExistingAuction(_nftAddress, _tokenId);

        require(block.timestamp > auction.endTime, "auction didn't end yet");
        require(auction.sellerPaid == false, "Seller already paid");
        require(auction.highestBidder != address(0), "auction must have at least one bid");
        require(
            auction.tokenTransactionDone == true,
            "Seller can request payment only after transfer of the reward to the winner"
        );

        uint256 highestBid = auction.bids[auction.highestBidder];
        uint256 toBePaidOut = highestBid;

        auction.sellerPaid = true;

        if(platformFee > 0 && feeRecipient != address(0)) {
            uint256 fee = (toBePaidOut * platformFee) / 100;
            toBePaidOut -= fee;

            payable(feeRecipient).transfer(fee);
        }

        // Send royalty to creator(minter)
        if (
            IFocusNFT1155(_nftAddress).creators(_tokenId) != address(0) &&
            royalties[_nftAddress][_tokenId] > 0
        ) {
            uint256 royaltyFee = (toBePaidOut * royalties[_nftAddress][_tokenId]) / 100;

            toBePaidOut -= royaltyFee;
            payable(IFocusNFT1155(_nftAddress).creators(_tokenId)).transfer(royaltyFee);
        }

        payable(auction.seller).transfer(toBePaidOut);
    }

    function requestPayment(
        address _nftAddress,
        uint256 _tokenId
    ) public afterStart(_nftAddress, _tokenId) {
        Auction storage auction = _getExistingAuction(_nftAddress, _tokenId);

        address sender = _msgSender();

        if(sender == auction.seller) {
            _paySeller(_nftAddress, _tokenId);
        } else if (sender == auction.highestBidder) {
            bool contractOk = _auctionTokenIsValidAndApproved(_nftAddress, _tokenId, auction.seller, auction.amount);

            /// @notice If the NFT is no longer approved to be transfered, the highest bidder is allowed to back out.
            if(contractOk == false || auction.cancelled) {
                uint256 bidToReturn = auction.bids[auction.highestBidder];
                auction.bids[auction.highestBidder] = 0;
                address highestBidder = auction.highestBidder;
                auction.highestBidder = address(0);

                payable(highestBidder).transfer(bidToReturn);
            }
        } else if (auction.bids[sender] > 0) {
            uint256 bidToReturn = auction.bids[sender];
            auction.bids[sender] = 0;

            payable(sender).transfer(bidToReturn);
        } else {
            revert("not authorized");
        }
    }

    /// @notice this is expensive
    /// @dev called by the backend to try to automatically send everybody what they should get. It's not safe to do it all at once, so a fallback system is necessary.
    function finalizeAuction(
        address _nftAddress,
        uint256 _tokenId
    ) public onlyOwner afterStart(_nftAddress, _tokenId) {
        Auction storage auction = _getExistingAuction(_nftAddress, _tokenId);

        address sender = _msgSender();

        // the auction has been Canceled or Ended
        require(auction.cancelled || block.timestamp > auction.endTime, "not end of auction yet");

        // only the owner or a bidder can finalize the auction
        require(sender == auction.seller || sender == owner || auction.bids[sender] > 0, "not authorized");

        // auction must have at least one bid
        require(auction.highestBidder != address(0), "auction must have at least one bid");

        if (auction.cancelled) { // auction canceled, not ended
            for(uint i = 0; i < auction.bidsInOrder.length; i++) {
                address bidder = auction.bidsInOrder[i].bidder;
                if(auction.bids[bidder] == 0) {
                    continue;
                }

                uint256 valueToTransfer = auction.bids[bidder];
                auction.bids[bidder] = 0;
                payable(bidder).transfer(valueToTransfer);
            }
        } else {// auction ended, not canceled
            transferTokenToHighestBidder(_nftAddress, _tokenId);

            _paySeller(_nftAddress, _tokenId);

            for(uint i = 0; i < auction.bidsInOrder.length; i++) {
                address bidder = auction.bidsInOrder[i].bidder;
                if(auction.bids[bidder] == 0) {
                    continue;
                }

                if(bidder == auction.highestBidder) {
                    continue;
                }

                uint256 valueToTransfer = auction.bids[bidder];
                auction.bids[bidder] = 0;
                payable(bidder).transfer(valueToTransfer);
            }
        }
        delete (auctionsByToken[_nftAddress][_tokenId]);
    }

    /// @notice Method for setting royalty
    /// @param _tokenId TokenId
    /// @param _royalty Royalty
    function registerRoyalty(
        address _nftAddress,
        uint256 _tokenId,
        uint8 _royalty
    ) external {
        if (IERC165(_nftAddress).supportsInterface(INTERFACE_ID_ERC1155)) {
            require(
                IFocusNFT1155(_nftAddress).creators(_tokenId) == _msgSender(),
                "Not minter of this item."
            );
        } else {
            revert("Invalid NFT address.");
        }
        royalties[_nftAddress][_tokenId] = _royalty;
    }
}
