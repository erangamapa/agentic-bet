/** ABI of contracts/SocialBetBook.sol — kept in sync by hand; it is small and stable. */
export const socialBetBookAbi = [
  {
    type: 'function',
    name: 'placeBetOnBehalfOf',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'bettor', type: 'address' },
      { name: 'marketId', type: 'bytes32' },
      { name: 'selectionId', type: 'bytes32' },
      { name: 'stake', type: 'uint256' },
      { name: 'oddsBps', type: 'uint256' },
      { name: 'intentHash', type: 'bytes32' },
    ],
    outputs: [{ name: 'betId', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'betId', type: 'bytes32' },
      { name: 'won', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'BetPlaced',
    inputs: [
      { name: 'betId', type: 'bytes32', indexed: true },
      { name: 'bettor', type: 'address', indexed: true },
      { name: 'marketId', type: 'bytes32', indexed: true },
      { name: 'selectionId', type: 'bytes32', indexed: false },
      { name: 'stake', type: 'uint256', indexed: false },
      { name: 'oddsBps', type: 'uint256', indexed: false },
      { name: 'intentHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'BetSettled',
    inputs: [
      { name: 'betId', type: 'bytes32', indexed: true },
      { name: 'won', type: 'bool', indexed: false },
      { name: 'payout', type: 'uint256', indexed: false },
    ],
  },
] as const;
