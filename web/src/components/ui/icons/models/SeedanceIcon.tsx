import type { CSSProperties } from "react";

interface IconProps {
  className?: string;
  style?: CSSProperties;
}

export function SeedanceIcon({ className, style }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      width="1em"
      height="1em"
      aria-hidden="true"
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.125em", ...style }}
    >
      <g clipPath="url(#IconModelSeedance__a)">
        <path d="M14.522 12.65c.214-.175.633.1.563.367l-.113.47c-.493 2.291.064 3.72-.21 4.82l-.08.27-.248-.043c-1.145-.263-2.158-1.366-4.422-1.923l-.505-.11c-.272-.053-.335-.55-.084-.665a27 27 0 0 0 2.095-1.089l.56-.335.397-.256c.62-.412 1.395-.972 2.047-1.506m-2.694 3.298c.542.225 1 .465 1.398.687.144.08.27.152.386.218a37 37 0 0 1-.034-.61c-.02-.413-.028-.874.002-1.388q-.23.16-.442.301l-.012.008-.397.255-.007.006-.008.005c-.252.157-.556.333-.886.518M4.06 2.655c-.148-.673.423-1.029.963-.6 2.215 1.762 6.248 6.38 11.427 4.814.853-.257 1.738.45 1.29 1.22l-.152.253c-1.613 2.582-4.413 4.332-5.983 5.313s-4.371 2.731-7.4 3.05l-.293.025c-.833.061-1.102-.906-.632-1.564l.104-.127c3.709-3.981 1.288-9.612.676-12.384m1.835 2.243c.262 1.004.523 2.163.641 3.38.223 2.296-.06 4.907-1.901 7.152 2.5-.422 4.838-1.858 6.334-2.793 1.497-.936 3.816-2.41 5.29-4.475-2.816.663-5.29-.226-7.26-1.427-1.226-.749-2.368-1.706-3.286-2.505q.088.314.182.668" />
      </g>
      <defs>
        <clipPath id="IconModelSeedance__a">
          <path fill="currentColor" d="M0 0h20v20H0z" />
        </clipPath>
      </defs>
    </svg>
  );
}

export default SeedanceIcon;
