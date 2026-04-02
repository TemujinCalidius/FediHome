import Link from "next/link";

export default function Pagination({
  currentPage,
  totalPages,
  basePath,
}: {
  currentPage: number;
  totalPages: number;
  basePath: string;
}) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-center gap-2 mt-10">
      {currentPage > 1 && (
        <Link
          href={currentPage === 2 ? basePath : `${basePath}?page=${currentPage - 1}`}
          className="btn-outlined text-xs !py-1.5 !px-3"
        >
          &larr; Newer
        </Link>
      )}

      <span className="text-xs text-gray-600 px-3">
        Page {currentPage} of {totalPages}
      </span>

      {currentPage < totalPages && (
        <Link
          href={`${basePath}?page=${currentPage + 1}`}
          className="btn-outlined text-xs !py-1.5 !px-3"
        >
          Older &rarr;
        </Link>
      )}
    </div>
  );
}
