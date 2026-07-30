// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SocialBetBook
 * @notice Minimal on-chain bet book used by the agentic social betting system.
 *
 * The backend operator places bets on behalf of users. Two properties matter for
 * the agent architecture above it:
 *
 *  1. `intentHash` is stored and emitted. It binds the transaction to the exact
 *     parameters the user confirmed off-chain (user, market, selection, stake,
 *     odds). The backend re-derives the hash from its own records and compares
 *     it against the emitted event, so a bet that was mutated in flight cannot
 *     be reported to the user as the bet they confirmed.
 *
 *  2. Placement is idempotent per `intentHash`. A retried broadcast reverts
 *     rather than double-staking the user.
 */
contract SocialBetBook {
    struct Bet {
        address bettor;
        bytes32 marketId;
        bytes32 selectionId;
        uint256 stake;
        uint256 oddsBps;
        bytes32 intentHash;
        uint64 placedAt;
        bool settled;
        bool won;
    }

    event BetPlaced(
        bytes32 indexed betId,
        address indexed bettor,
        bytes32 indexed marketId,
        bytes32 selectionId,
        uint256 stake,
        uint256 oddsBps,
        bytes32 intentHash
    );

    event BetSettled(bytes32 indexed betId, bool won, uint256 payout);

    error NotOperator();
    error DuplicateIntent(bytes32 intentHash);
    error InvalidStake();
    error InvalidOdds();
    error UnknownBet(bytes32 betId);
    error AlreadySettled(bytes32 betId);

    address public immutable operator;

    mapping(bytes32 => Bet) public bets;
    mapping(bytes32 => bytes32) public betIdByIntent;

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address _operator) {
        operator = _operator;
    }

    /**
     * @param bettor       Address the bet belongs to.
     * @param marketId     Market identifier, keccak256 of the off-chain market id.
     * @param selectionId  Selection identifier within the market.
     * @param stake        Stake in the smallest unit of the settlement token.
     * @param oddsBps      Decimal odds in basis points (2.50 -> 25000).
     * @param intentHash   Hash of the parameters the user explicitly confirmed.
     */
    function placeBetOnBehalfOf(
        address bettor,
        bytes32 marketId,
        bytes32 selectionId,
        uint256 stake,
        uint256 oddsBps,
        bytes32 intentHash
    ) external onlyOperator returns (bytes32 betId) {
        if (stake == 0) revert InvalidStake();
        if (oddsBps <= 10000) revert InvalidOdds();
        if (betIdByIntent[intentHash] != bytes32(0)) revert DuplicateIntent(intentHash);

        betId = keccak256(abi.encode(bettor, marketId, selectionId, stake, oddsBps, intentHash, block.number));

        bets[betId] = Bet({
            bettor: bettor,
            marketId: marketId,
            selectionId: selectionId,
            stake: stake,
            oddsBps: oddsBps,
            intentHash: intentHash,
            placedAt: uint64(block.timestamp),
            settled: false,
            won: false
        });
        betIdByIntent[intentHash] = betId;

        emit BetPlaced(betId, bettor, marketId, selectionId, stake, oddsBps, intentHash);
    }

    function settle(bytes32 betId, bool won) external onlyOperator {
        Bet storage bet = bets[betId];
        if (bet.bettor == address(0)) revert UnknownBet(betId);
        if (bet.settled) revert AlreadySettled(betId);

        bet.settled = true;
        bet.won = won;

        uint256 payout = won ? (bet.stake * bet.oddsBps) / 10000 : 0;
        emit BetSettled(betId, won, payout);
    }

    function getBet(bytes32 betId) external view returns (Bet memory) {
        return bets[betId];
    }
}
