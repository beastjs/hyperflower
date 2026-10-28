// Interactive preview for generated 3D models. Loaded on demand: three.js and each format's
// loader are separate chunks, fetched only when a model card is on screen.
import {
  ACESFilmicToneMapping,
  Box3,
  type BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { Model3DFormat } from './ark'

const loadModel = async (url: string, format: Model3DFormat): Promise<Object3D> => {
  switch (format) {
    case 'glb': {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
      return (await new GLTFLoader().loadAsync(url)).scene
    }
    case 'obj': {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js')
      return new OBJLoader().loadAsync(url)
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
      return new FBXLoader().loadAsync(url)
    }
    case 'usdz': {
      const { USDLoader } = await import('three/examples/jsm/loaders/USDLoader.js')
      return new USDLoader().loadAsync(url)
    }
    case 'stl': {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js')
      const geometry: BufferGeometry = await new STLLoader().loadAsync(url)
      geometry.computeVertexNormals()
      return new Mesh(geometry, new MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.6 }))
    }
  }
}

/** Place the model at the origin and back the camera off until all of it is in view. */
const frame = (model: Object3D, camera: PerspectiveCamera, controls: OrbitControls) => {
  const box = new Box3().setFromObject(model)
  const center = box.getCenter(new Vector3())
  const radius = box.getSize(new Vector3()).length() / 2 || 1
  model.position.sub(center)
  const distance = radius / Math.sin((camera.fov * Math.PI) / 360)
  camera.position.set(distance * 0.6, distance * 0.35, distance * 0.75)
  camera.near = distance / 100
  camera.far = distance * 100
  camera.updateProjectionMatrix()
  controls.target.set(0, 0, 0)
  controls.update()
}

/**
 * Render the model into `container` with orbit controls and a slow turntable.
 * Resolves with a cleanup function once the model is on screen; rejects if it cannot load.
 */
export async function mountViewer(container: HTMLElement, url: string, format: Model3DFormat): Promise<() => void> {
  const model = await loadModel(url, format)

  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.domElement.className = 'size-full touch-none'
  container.append(renderer.domElement)

  const scene = new Scene()
  const pmrem = new PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.add(model)

  const camera = new PerspectiveCamera(35, 1, 0.01, 1000)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.autoRotate = true
  controls.autoRotateSpeed = 1.2
  // Stop the turntable once someone grabs the model.
  controls.addEventListener('start', () => (controls.autoRotate = false))
  frame(model, camera, controls)

  const resize = () => {
    const { clientWidth: width, clientHeight: height } = container
    if (!width || !height) return
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)
  resize()

  renderer.setAnimationLoop(() => {
    controls.update()
    renderer.render(scene, camera)
  })

  return () => {
    renderer.setAnimationLoop(null)
    observer.disconnect()
    controls.dispose()
    pmrem.dispose()
    renderer.dispose()
    renderer.domElement.remove()
  }
}
