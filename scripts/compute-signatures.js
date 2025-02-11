import { id, Fragment } from 'ethers';

// ABI fragments for the events we care about
const EVENT_ABIS = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId, uint256 id)',
  'event Burn(address indexed from, uint256 indexed tokenId, uint256 id)',
  'event Mint(address indexed to, uint256 indexed tokenId, uint256 id)',
  'event Staked(address indexed staker, uint256 indexed tokenId, uint256 id)',
  'event Unstaked(address indexed staker, uint256 indexed tokenId, uint256 id)'
];

// Current signatures in the codebase
const CURRENT_SIGNATURES = {
  Transfer: '0x9ed053bb818ff08b8353cd46f78db1f0799f31c9e4458fdb425c10eccd2efc44',
  Burn: '0x49995e5dd6158cf69ad3e9777c46755a1a826a446c6416992167462dad033b2a',
  Mint: '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
  Staked: '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90',
  Unstaked: '0x7fc4727e062e336010f2c282598ef5f14facb3de68cf8195c2f23e1454b2b74e'
};

console.log('Computing Event Signatures');
console.log('=========================\n');

EVENT_ABIS.forEach(eventAbi => {
  const fragment = Fragment.from(eventAbi);
  const signature = id(fragment.format());
  const eventName = fragment.name;
  const currentSig = CURRENT_SIGNATURES[eventName];
  
  console.log(`Event: ${eventName}`);
  console.log(`Format: ${fragment.format()}`);
  console.log(`Computed: ${signature}`);
  console.log(`Current:  ${currentSig}`);
  console.log(`Match: ${signature === currentSig ? '✅' : '❌'}`);
  console.log('-------------------------\n');
});

// Output in format ready to paste into code
console.log('Updated KNOWN_SIGNATURES object:');
console.log('===============================\n');
console.log('const KNOWN_SIGNATURES = {');
EVENT_ABIS.forEach(eventAbi => {
  const fragment = Fragment.from(eventAbi);
  const signature = id(fragment.format());
  console.log(`  ${fragment.name}: '${signature}',`);
});
console.log('};\n'); 