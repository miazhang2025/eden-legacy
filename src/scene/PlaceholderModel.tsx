import type { Material } from 'three'
import type { Category } from '../data/assets'

// 美术资产未到位前的占位几何体（drei/three 内置几何），按类别区分外形。
// 所有子 mesh 共用传入的 material，方便外部统一控制发光与淡出。
export function PlaceholderModel({ category, material }: { category: Category; material: Material }) {
  switch (category) {
    case 'mineral':
      return (
        <mesh material={material} castShadow>
          <octahedronGeometry args={[0.5, 0]} />
        </mesh>
      )
    case 'plant':
      return (
        <group>
          <mesh material={material} position={[0, -0.15, 0]} castShadow>
            <cylinderGeometry args={[0.08, 0.12, 0.5, 12]} />
          </mesh>
          <mesh material={material} position={[0, 0.12, 0]} castShadow>
            <sphereGeometry args={[0.38, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
          </mesh>
        </group>
      )
    case 'shell':
      return (
        <mesh material={material} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <torusKnotGeometry args={[0.28, 0.1, 64, 12, 2, 3]} />
        </mesh>
      )
    case 'fish':
      return (
        <group rotation={[0, 0, Math.PI / 2]}>
          <mesh material={material} castShadow>
            <capsuleGeometry args={[0.18, 0.5, 6, 12]} />
          </mesh>
          <mesh material={material} position={[0, -0.5, 0]} castShadow>
            <coneGeometry args={[0.2, 0.25, 4]} />
          </mesh>
        </group>
      )
    case 'flower':
      return (
        <group>
          <mesh material={material} position={[0, -0.2, 0]}>
            <cylinderGeometry args={[0.03, 0.03, 0.6, 8]} />
          </mesh>
          <mesh material={material} position={[0, 0.15, 0]} castShadow>
            <dodecahedronGeometry args={[0.28, 0]} />
          </mesh>
        </group>
      )
    case 'butterfly':
      return (
        <group>
          <mesh material={material} position={[-0.22, 0, 0]} rotation={[0, 0.4, 0]}>
            <circleGeometry args={[0.25, 5]} />
          </mesh>
          <mesh material={material} position={[0.22, 0, 0]} rotation={[0, -0.4, 0]}>
            <circleGeometry args={[0.25, 5]} />
          </mesh>
          <mesh material={material}>
            <capsuleGeometry args={[0.04, 0.3, 4, 8]} />
          </mesh>
        </group>
      )
  }
}
