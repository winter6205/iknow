import { staggerStyle } from "../lib/stagger";

export type UserMessageProps = {
  text: string;
  staggerIndex?: number;
};

// Right-aligned user bubble (decision #11). Pill hugs the right edge of the
// chat column — width fits content with a soft cap so short messages don't
// leave a big empty gap trailing to the right. Slight saturation bump +
// hairline shadow so the bubble reads against the warm bg without shouting.
export function UserMessage({ text, staggerIndex = 0 }: UserMessageProps) {
  return (
    <article
      aria-label="用户提问"
      className="self-end ml-auto w-fit max-w-[min(80%,34rem)] rounded-pill bg-[#dde2d4] px-[15px] py-[9px] text-ink shadow-bubble animate-message-in"
      style={staggerStyle(staggerIndex)}
    >
      <p className="m-0 text-[14px] leading-[1.55]">{text}</p>
    </article>
  );
}
