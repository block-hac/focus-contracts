// SPDX-License-Identifier: MIT

pragma solidity >=0.6.0 <0.8.0;

import "@openzeppelin/contracts/introspection/IERC165.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IFocusNFT1155 {
    function creators(uint256) external returns (address);
}

contract FocusMarketplace is Ownable, ReentrancyGuard {
    using SafeMath for uint256;
    using Address for address payable;
    using SafeERC20 for IERC20;

    /// @notice Events for the contract
    event ItemListed(
        address indexed owner,
        address indexed nft,
        uint256 indexed tokenId,
        uint256 quantity,
        uint256 pricePerItem,
        uint256 startingTime,
        bool isPrivate,
        address allowedAddress
    );
    event ItemSold(
        address indexed seller,
        address indexed buyer,
        address nft,
        uint256 indexed tokenId,
        uint256 quantity,
        uint256 price
    );
    event ItemUpdated(
        address indexed owner,
        address indexed nft,
        uint256 indexed tokenId,
        uint256 newPrice
    );
    event ItemCanceled(address indexed owner, address indexed nft, uint256 tokenId);
    event UpdatePlatformFee(uint256 platformFee);
    event UpdatePlatformFeeRecipient(address payable platformFeeRecipient);

    /// @notice Structure for listed items
    struct Listing {
        uint256 quantity;
        uint256 pricePerItem;
        uint256 startingTime;
        address allowedAddress;
    }

    bytes4 private constant INTERFACE_ID_ERC1155 = 0xd9b67a26;

    /// @notice NftAddress -> Token ID -> Royalty
    mapping(uint256 => uint8) public royalties;

    /// @notice NftAddress -> Token ID -> Owner -> Listing item
    mapping(address => mapping(uint256 => mapping(address => Listing))) public listings;

    /// @notice Platform fee
    uint256 public platformFee;

    /// @notice Platform fee receipient
    address payable public feeReceipient;

    /// @notice Focus721 contract
    address public focus721;

    /// @notice Contract constructor
    constructor(address payable _feeRecipient, uint256 _platformFee) public {
        platformFee = _platformFee;
        feeReceipient = _feeRecipient;
    }

    /// @notice Method for listing NFT
    /// @param _nftAddress Address of NFT contract
    /// @param _tokenId Token ID of NFT
    /// @param _quantity token amount to list (needed for ERC-1155 NFTs, set as 1 for ERC-721)
    /// @param _pricePerItem sale price for each iteam
    /// @param _startingTime scheduling for a future sale
    /// @param _allowedAddress optional param for private sale
    function listItem(
        address _nftAddress,
        uint256 _tokenId,
        uint256 _quantity,
        uint256 _pricePerItem,
        uint256 _startingTime,
        address _allowedAddress
    ) external {
        if (IERC165(_nftAddress).supportsInterface(INTERFACE_ID_ERC1155)) {
            IERC1155 nft = IERC1155(_nftAddress);
            require(nft.balanceOf(_msgSender(), _tokenId) >= _quantity, "Must hold enough NFTs.");
            require(
                nft.isApprovedForAll(_msgSender(), address(this)),
                "Must be approved before list."
            );
        } else {
            revert("Invalid NFT address.");
        }

        listings[_nftAddress][_tokenId][_msgSender()] = Listing(
            _quantity,
            _pricePerItem,
            _startingTime,
            _allowedAddress
        );
        emit ItemListed(
            _msgSender(),
            _nftAddress,
            _tokenId,
            _quantity,
            _pricePerItem,
            _startingTime,
            _allowedAddress == address(0x0),
            _allowedAddress
        );
    }

    /// @notice Method for canceling listed NFT
    function cancelListing(address _nftAddress, uint256 _tokenId) external nonReentrant {
        require(listings[_nftAddress][_tokenId][_msgSender()].quantity > 0, "Not listed item.");
        _cancelListing(_nftAddress, _tokenId, _msgSender());
    }

    /// @notice Method for updating listed NFT
    /// @param _nftAddress Address of NFT contract
    /// @param _tokenId Token ID of NFT
    /// @param _newPrice New sale price for each iteam
    function updateListing(
        address _nftAddress,
        uint256 _tokenId,
        uint256 _newPrice
    ) external nonReentrant {
        Listing storage listedItem = listings[_nftAddress][_tokenId][_msgSender()];
        require(listedItem.quantity > 0, "Not listed item.");
        if (IERC165(_nftAddress).supportsInterface(INTERFACE_ID_ERC1155)) {
            IERC1155 nft = IERC1155(_nftAddress);
            require(
                nft.balanceOf(_msgSender(), _tokenId) >= listedItem.quantity,
                "Not owning the item."
            );
        } else {
            revert("Invalid NFT address.");
        }

        listedItem.pricePerItem = _newPrice;
        emit ItemUpdated(_msgSender(), _nftAddress, _tokenId, _newPrice);
    }

    /// @notice Method for buying listed NFT
    /// @param _nftAddress NFT contract address
    /// @param _tokenId TokenId
    function buyItem(
        address _nftAddress,
        uint256 _tokenId,
        address payable _owner
    ) external payable nonReentrant {
        Listing storage listedItem = listings[_nftAddress][_tokenId][_owner];

        require(listedItem.quantity > 0, "Not listed item.");

        if (IERC165(_nftAddress).supportsInterface(INTERFACE_ID_ERC1155)) {
            IERC1155 nft = IERC1155(_nftAddress);
            require(nft.balanceOf(_owner, _tokenId) >= listedItem.quantity, "Not owning the item.");
        } else {
            revert("Invalid NFT address.");
        }

        require(_getNow() >= listedItem.startingTime, "Item is not buyable yet.");
        require(msg.value >= listedItem.pricePerItem, "Not enough amount to buy item.");

        if (listedItem.allowedAddress != address(0)) {
            require(listedItem.allowedAddress == _msgSender(), "You are not eligable to buy item.");
        }

        uint256 feeAmount = msg.value.mul(platformFee).div(1e3);
        (bool feeTransferSuccess, ) = feeReceipient.call{ value: feeAmount }("");
        require(feeTransferSuccess, "FocusMarketplace: Fee transfer failed");

        // Send royalty to creator(minter)
        if (
            IFocusNFT1155(_nftAddress).creators(_tokenId) != address(0) &&
            royalties[_tokenId] != uint8(0)
        ) {
            uint256 royaltyFee = msg.value.sub(feeAmount).mul(royalties[_tokenId]).div(100);
            (bool royaltyTransferSuccess, ) = payable(IFocusNFT1155(_nftAddress).creators(_tokenId))
                .call{ value: royaltyFee }("");
            require(royaltyTransferSuccess, "FomoMarketplace: Royalty fee transfer failed");
            feeAmount = feeAmount.add(royaltyFee);
        }

        (bool ownerTransferSuccess, ) = _owner.call{ value: msg.value.sub(feeAmount) }("");
        require(ownerTransferSuccess, "FocusMarketplace: Owner transfer failed");

        // Transfer NFT to buyer
        IERC1155(_nftAddress).safeTransferFrom(_owner, _msgSender(), _tokenId, 1, bytes(""));

        emit ItemSold(
            _owner,
            _msgSender(),
            _nftAddress,
            _tokenId,
            1,
            msg.value.div(listedItem.quantity)
        );
        listedItem.quantity = listedItem.quantity.sub(1);

        delete (listings[_nftAddress][_tokenId][_owner]);
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
        royalties[_tokenId] = _royalty;
    }

    /**
     @notice Method for updating platform fee
     @dev Only admin
     @param _platformFee uint256 the platform fee to set
     */
    function updatePlatformFee(uint256 _platformFee) external onlyOwner {
        platformFee = _platformFee;
        emit UpdatePlatformFee(_platformFee);
    }

    /**
     @notice Method for updating platform fee address
     @dev Only admin
     @param _platformFeeRecipient payable address the address to sends the funds to
     */
    function updatePlatformFeeRecipient(address payable _platformFeeRecipient) external onlyOwner {
        feeReceipient = _platformFeeRecipient;
        emit UpdatePlatformFeeRecipient(_platformFeeRecipient);
    }

    ////////////////////////////
    /// Internal and Private ///
    ////////////////////////////

    function _getNow() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    function _cancelListing(
        address _nftAddress,
        uint256 _tokenId,
        address _owner
    ) private {
        Listing memory listedItem = listings[_nftAddress][_tokenId][_owner];
        if (IERC165(_nftAddress).supportsInterface(INTERFACE_ID_ERC1155)) {
            IERC1155 nft = IERC1155(_nftAddress);
            require(
                nft.balanceOf(_msgSender(), _tokenId) >= listedItem.quantity,
                "Not owning the item."
            );
        } else {
            revert("Invalid NFT address.");
        }

        delete (listings[_nftAddress][_tokenId][_owner]);
        emit ItemCanceled(_owner, _nftAddress, _tokenId);
    }
}
