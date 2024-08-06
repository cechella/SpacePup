require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // Importa e configura dotenv

module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.24", // Alinha com a versão necessária pelo OpenZeppelin
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],
  },
  networks: {
    bsc: {
      url: "https://bsc-dataseed.binance.org/",
      accounts: [process.env.PRIVATE_KEY], // Usa a chave privada do .env
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY, // Usa a chave da Etherscan do .env
  },
};

