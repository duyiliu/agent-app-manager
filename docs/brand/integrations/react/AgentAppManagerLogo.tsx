import type { ImgHTMLAttributes } from 'react';

type Variant = 'icon' | 'mark-dark' | 'mark-light' | 'horizontal-dark' | 'horizontal-light';
const filenames: Record<Variant, string> = {
  icon: 'app-icon.svg',
  'mark-dark': 'mark-on-dark.svg',
  'mark-light': 'mark-on-light.svg',
  'horizontal-dark': 'logo-horizontal-on-dark.svg',
  'horizontal-light': 'logo-horizontal-on-light.svg',
};

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  variant?: Variant;
  size?: number;
  basePath?: string;
};
/** Copy assets/svg/* to public/brand/ first. */
export function AgentAppManagerLogo({
  variant = 'icon', size = 40, basePath = '/brand', alt = 'Agent App Manager', style, ...rest
}: Props) {
  const horizontal = variant.startsWith('horizontal');
  return (
    <img
      {...rest}
      src={`${basePath.replace(/\/$/, '')}/${filenames[variant]}`}
      width={horizontal ? Math.round(size * 850 / 148) : size}
      height={size}
      alt={alt}
      draggable={false}
      style={{ display: 'block', objectFit: 'contain', flexShrink: 0, ...style }}
    />
  );
}
