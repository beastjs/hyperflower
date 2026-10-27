import { hf, type ImageInputOptions } from '.'

type Imagens = 'soul' | 'soulv2' | 'soulcinema'

const imageMap: Record<Imagens, string> = {
  soul: 'higgsfield-ai/soul/standard',
  soulv2: 'higgsfield-ai/soul/v2/standar',
  soulcinema: 'higgsfield-ai/soul/cinema'
}

export const text2Image = async ({
  aspect_ratio = '9:16',
  safety_tolerance = 2,
  seed = 4,
  ...input
}: ImageInputOptions) => {
  const jobSet = await hf.subscribe('flux-pro/kontext/max/text-to-image', {
    input: { aspect_ratio, safety_tolerance, seed, ...input },
    withPolling: true
  })

  if (jobSet.status === 'completed') {
    if (jobSet.images) {
      console.log('Image URL:', jobSet.images[0].url)
    }
  }
}
