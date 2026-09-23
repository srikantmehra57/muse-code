import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export type SelectMenuOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  icon?: ReactNode;
  tone?: "danger";
};

type SelectMenuProps = {
  id: string;
  value?: string;
  placeholder: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  icon?: ReactNode;
  label?: string;
  heading?: string;
  className?: string;
  ariaLabel?: string;
};

function firstEnabled(options: SelectMenuOption[]) {
  return options.findIndex((option) => !option.disabled);
}

function lastEnabled(options: SelectMenuOption[]) {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index].disabled) return index;
  }
  return -1;
}

export function SelectMenu({
  id,
  value,
  placeholder,
  options,
  onChange,
  disabled = false,
  icon,
  label,
  heading,
  className = "",
  ariaLabel,
}: SelectMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = `${useId()}-listbox`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const index = activeIndex >= 0 ? activeIndex : firstEnabled(options);
    if (index >= 0) {
      optionRefs.current[index]?.focus();
    }
  }, [activeIndex, open, options]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const openMenu = (direction: 1 | -1 = 1) => {
    if (disabled || !options.some((option) => !option.disabled)) return;
    const start = selectedIndex >= 0 && !options[selectedIndex].disabled
      ? selectedIndex
      : direction === 1 ? firstEnabled(options) : lastEnabled(options);
    setActiveIndex(start);
    setOpen(true);
  };

  const move = (from: number, direction: 1 | -1) => {
    if (!options.length) return from;
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (from + direction * offset + options.length * 2) % options.length;
      if (!options[index].disabled) return index;
    }
    return from;
  };

  const choose = (option: SelectMenuOption) => {
    if (option.disabled) return;
    onChange(option.value);
    close();
  };

  return (
    <div ref={rootRef} className={`select-menu ${className}`.trim()}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="select-trigger"
        disabled={disabled}
        aria-label={ariaLabel ?? label ?? placeholder}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openMenu(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(-1);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!open) openMenu();
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          }
        }}
      >
        {icon}
        {label ? <span className="selector-label">{label}</span> : null}
        <span className={`select-value ${selected ? "" : "placeholder"}`.trim()}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className="select-chevron" size={12} aria-hidden="true" data-open={open || undefined} />
      </button>
      {open ? (
        <div id={listboxId} className="select-menu-popover" role="listbox" aria-label={ariaLabel ?? label ?? placeholder}>
          {heading ? <div className="menu-heading" aria-hidden="true">{heading}</div> : null}
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(node) => { optionRefs.current[index] = node; }}
              type="button"
              role="option"
              className={`select-option ${index === activeIndex ? "active" : ""} ${option.tone ?? ""}`.trim()}
              aria-selected={index === selectedIndex}
              disabled={option.disabled}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(option)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex(move(index, event.key === "ArrowDown" ? 1 : -1));
                } else if (event.key === "Home") {
                  event.preventDefault();
                  setActiveIndex(firstEnabled(options));
                } else if (event.key === "End") {
                  event.preventDefault();
                  setActiveIndex(lastEnabled(options));
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  choose(option);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                } else if (event.key === "Tab") {
                  setOpen(false);
                }
              }}
            >
              {option.icon ? <span className="option-icon" aria-hidden="true">{option.icon}</span> : null}
              <span className="option-copy">
                <span>{option.label}</span>
                {option.description ? <small>{option.description}</small> : null}
              </span>
              {index === selectedIndex ? <Check size={14} className="option-check" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
