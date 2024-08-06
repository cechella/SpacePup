// scripts/deploy.js

async function main() {
  // Importa o objeto ethers da biblioteca hardhat
  const hre = require("hardhat");
  const { ethers } = hre; // Certifique-se de que ethers está sendo importado corretamente

  // Obtém a conta que fará o deploy
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

  // Determina o supply inicial para o token
  const initialSupply = ethers.parseUnits("1000000000", 18); // Alinhado para ethers@6.x

  // Obtenha o contrato do token
  const Token = await ethers.getContractFactory("SpacePupToken");

  // Passe o supply inicial como argumento para o construtor
  const token = await Token.deploy(initialSupply);

  // Aguarda a confirmação do deploy usando waitForDeployment
  await token.waitForDeployment();

  // Obter o endereço do contrato implantado
  const address = await token.getAddress();

  console.log("SpacePupToken deployed to:", address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error during deployment:", error);
    process.exit(1);
  });
