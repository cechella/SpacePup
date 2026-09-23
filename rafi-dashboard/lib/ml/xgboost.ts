/**
 * Gradient Boosted Decision Trees — TypeScript puro, sem dependências externas.
 * Algoritmo: XGBoost simplificado com log loss (classificação binária).
 * Calibrado para 50–300 amostras: 30 árvores, profundidade 3, lr 0.1.
 */

interface TreeNode {
  featureIdx?: number
  threshold?:  number
  left?:       TreeNode
  right?:      TreeNode
  value?:      number     // folha: gamma (Newton-Raphson step)
}

export interface XGBoostModel {
  trees:         TreeNode[]
  learningRate:  number
  baseScore:     number    // log-odds do prior
  nFeatures:     number
  trainedAt:     string
  nSamples:      number
  trainAccuracy: number
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x))))
}

function logit(p: number): number {
  const c = Math.max(1e-7, Math.min(1 - 1e-7, p))
  return Math.log(c / (1 - c))
}

// Ganho de um nó usando o critério XGBoost (soma²/denominador com regularização L2)
function nodeScore(indices: number[], residuals: number[], probs: number[], lambda = 1.0): number {
  let num = 0, den = lambda
  for (const i of indices) {
    num += residuals[i]
    den += probs[i] * (1 - probs[i])
  }
  return (num * num) / den
}

// Valor ótimo de uma folha (Newton-Raphson step)
function leafValue(indices: number[], residuals: number[], probs: number[], lambda = 1.0): number {
  let num = 0, den = lambda
  for (const i of indices) {
    num += residuals[i]
    den += probs[i] * (1 - probs[i])
  }
  return den === 0 ? 0 : num / den
}

// Constrói uma árvore recursivamente por busca exaustiva de splits
function buildTree(
  X: number[][],
  residuals: number[],
  probs: number[],
  indices: number[],
  depth: number,
  maxDepth: number,
): TreeNode {
  if (depth >= maxDepth || indices.length < 4) {
    return { value: leafValue(indices, residuals, probs) }
  }

  const nFeatures = X[0].length
  let bestGain = 1e-9
  let bestFeat = -1
  let bestThresh = 0
  let bestLeft: number[] = []
  let bestRight: number[] = []

  const parentScore = nodeScore(indices, residuals, probs)

  for (let f = 0; f < nFeatures; f++) {
    // Candidatos únicos de threshold
    const seen: Record<number, true> = {}
    const vals = indices.map(i => X[i][f]).filter(v => { if (seen[v]) return false; seen[v] = true; return true }).sort((a, b) => a - b)
    for (let t = 0; t < vals.length - 1; t++) {
      const thresh = (vals[t] + vals[t + 1]) / 2
      const left  = indices.filter(i => X[i][f] <= thresh)
      const right = indices.filter(i => X[i][f] >  thresh)
      if (left.length < 2 || right.length < 2) continue

      const gain = nodeScore(left, residuals, probs) + nodeScore(right, residuals, probs) - parentScore
      if (gain > bestGain) {
        bestGain = gain; bestFeat = f; bestThresh = thresh
        bestLeft = left; bestRight = right
      }
    }
  }

  if (bestFeat === -1) {
    return { value: leafValue(indices, residuals, probs) }
  }

  return {
    featureIdx: bestFeat,
    threshold:  bestThresh,
    left:  buildTree(X, residuals, probs, bestLeft,  depth + 1, maxDepth),
    right: buildTree(X, residuals, probs, bestRight, depth + 1, maxDepth),
  }
}

function predictTree(node: TreeNode, x: number[]): number {
  if (node.value !== undefined) return node.value
  if (node.featureIdx === undefined || node.threshold === undefined) return 0
  return x[node.featureIdx] <= node.threshold
    ? predictTree(node.left!, x)
    : predictTree(node.right!, x)
}

export function trainXGBoost(
  X: number[][],
  y: number[],  // 0=loss, 1=win
  nEstimators = 30,
  maxDepth = 3,
  learningRate = 0.1,
): XGBoostModel {
  const n = X.length
  const meanY = y.reduce((s, v) => s + v, 0) / n
  const baseScore = logit(meanY)

  const rawScores = new Array(n).fill(baseScore)
  const trees: TreeNode[] = []
  const indices = Array.from({ length: n }, (_, i) => i)

  for (let iter = 0; iter < nEstimators; iter++) {
    const probs     = rawScores.map(sigmoid)
    const residuals = y.map((yi, i) => yi - probs[i])

    const root = buildTree(X, residuals, probs, indices, 0, maxDepth)
    trees.push(root)

    for (let i = 0; i < n; i++) {
      rawScores[i] += learningRate * predictTree(root, X[i])
    }
  }

  let correct = 0
  for (let i = 0; i < n; i++) {
    if ((sigmoid(rawScores[i]) >= 0.5 ? 1 : 0) === y[i]) correct++
  }

  return {
    trees,
    learningRate,
    baseScore,
    nFeatures:     X[0]?.length ?? 0,
    trainedAt:     new Date().toISOString(),
    nSamples:      n,
    trainAccuracy: correct / n,
  }
}

export function predictXGBoost(model: XGBoostModel, x: number[]): number {
  let score = model.baseScore
  for (const tree of model.trees) {
    score += model.learningRate * predictTree(tree, x)
  }
  return sigmoid(score)
}
